# packages/coral-backend/src/coral_backend/models.py
# inventory mlx checkpoints and derive honest ModelInfo from config.json

from __future__ import annotations

from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import hashlib
import json
import threading

from coral_backend.errors import WorkerError
from coral_backend.protocol import Model, ModelInfo

WEIGHT_SUFFIXES = (".safetensors", ".npz", ".gguf", ".bin", ".pt", ".ggml", ".mlx")
SKIP_DIR_NAMES = {".git", "__pycache__", ".venv", "node_modules"}
MAX_SCAN_DEPTH = 3
HASH_CHUNK_BYTES = 1024 * 1024
MAX_DIGEST_CACHE_ENTRIES = 32

# coral/mlx-artifact/v1: SHA-256 over config.json + weight files + tokenizer files.
# file set is closed; order is posix-relative path (case-sensitive). hashed file
# bytes are themselves SHA-256'd so the outer hash stays cheap to combine.
ARTIFACT_DIGEST_VERSION = "coral/mlx-artifact/v1"
TOKENIZER_DIGEST_NAMES = frozenset(
    {
        "tokenizer.json",
        "tokenizer.model",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "vocab.json",
        "merges.txt",
        "added_tokens.json",
        "sentencepiece.bpe.model",
        "spiece.model",
        "chat_template.jinja",
        "chat_template.json",
        "processor_config.json",
        "preprocessor_config.json",
    }
)

type DigestFingerprint = tuple[tuple[str, int, int, int, int, int], ...]

# ctime + inode close the equal-size/restored-mtime hole without re-reading 80 GB
_DIGEST_CACHE: OrderedDict[str, tuple[DigestFingerprint, str]] = OrderedDict()
_DIGEST_CACHE_LOCK = threading.Lock()

# map checkpoint model_type onto the ids src/config/context.ts pins / budgets
ARCH_ALIASES = {
    "gemma": "gemma",
    "gemma2": "gemma2",
    "gemma3": "gemma3",
    "gemma3_text": "gemma3",
    "gemma3n": "gemma3",
    "gemma4": "gemma4",
    "gemma4_text": "gemma4",
    "qwen2": "qwen2",
    "qwen3": "qwen3",
    "qwen3_moe": "qwen3",
    "qwen3_vl": "qwen3",
}


def list_models(models_dir: Path) -> list[Model]:
    models: list[Model] = []
    for name, path in _iter_checkpoints(models_dir):
        size = weight_bytes(path)
        models.append(
            Model(
                name=name,
                model=name,
                size=size,
                modified_at=_modified_at(path),
                digest=artifact_digest(path),
            )
        )
    models.sort(key=lambda item: item.name)
    return models


def show_model(models_dir: Path, name: str) -> tuple[ModelInfo, int]:
    path = resolve_checkpoint(models_dir, name)
    config = read_config(path)
    size = weight_bytes(path)
    info = model_info_from_config(config)
    return info.model_copy(update={"size": float(size), "digest": artifact_digest(path)}), size


def artifact_digest(path: Path) -> str:
    checkpoint = path.resolve()
    key = str(checkpoint)
    for _attempt in range(2):
        try:
            files, before = _digest_state(checkpoint)
            with _DIGEST_CACHE_LOCK:
                cached = _DIGEST_CACHE.get(key)
                if cached is not None and cached[0] == before:
                    _DIGEST_CACHE.move_to_end(key)
                    return cached[1]
            hasher = hashlib.sha256()
            hasher.update(ARTIFACT_DIGEST_VERSION.encode("utf-8"))
            hasher.update(b"\0")
            for rel, file_path in files:
                hasher.update(rel.encode("utf-8"))
                hasher.update(b"\0")
                hasher.update(_file_digest(file_path))
                hasher.update(b"\0")
            _after_files, after = _digest_state(checkpoint)
        except OSError:
            continue
        if before != after:
            continue
        digest = hasher.hexdigest()
        with _DIGEST_CACHE_LOCK:
            _DIGEST_CACHE[key] = (after, digest)
            _DIGEST_CACHE.move_to_end(key)
            while len(_DIGEST_CACHE) > MAX_DIGEST_CACHE_ENTRIES:
                _DIGEST_CACHE.popitem(last=False)
        return digest
    raise WorkerError(
        "model_artifact_changed",
        f"checkpoint {checkpoint} changed while Coral was hashing it",
    )


def _digest_state(
    checkpoint: Path,
) -> tuple[list[tuple[str, Path]], DigestFingerprint]:
    files = _digest_files(checkpoint)
    fingerprint: list[tuple[str, int, int, int, int, int]] = []
    for rel, file_path in files:
        stat = file_path.stat()
        fingerprint.append(
            (
                rel,
                stat.st_dev,
                stat.st_ino,
                stat.st_size,
                stat.st_mtime_ns,
                stat.st_ctime_ns,
            )
        )
    return files, tuple(fingerprint)


def _file_digest(path: Path) -> bytes:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(HASH_CHUNK_BYTES):
            hasher.update(chunk)
    return hasher.digest()


def _digest_files(checkpoint: Path) -> list[tuple[str, Path]]:
    found: list[tuple[str, Path]] = []
    for file in checkpoint.rglob("*"):
        if not file.is_file():
            continue
        try:
            relative = file.relative_to(checkpoint)
        except ValueError:
            continue
        if any(part in SKIP_DIR_NAMES or part.startswith(".") for part in relative.parts):
            continue
        if not _is_digest_file(relative, file):
            continue
        found.append((relative.as_posix(), file))
    found.sort(key=lambda item: item[0])
    return found


def _is_digest_file(relative: Path, file: Path) -> bool:
    name = file.name
    if name == "config.json" and len(relative.parts) == 1:
        return True
    if _is_weight_file(file):
        return True
    if name.endswith(".safetensors.index.json"):
        return True
    return name in TOKENIZER_DIGEST_NAMES


def resolve_checkpoint(models_dir: Path, name: str) -> Path:
    requested = Path(name)
    if requested.is_absolute() or ".." in requested.parts:
        raise WorkerError(
            "model_not_found",
            f"mlx checkpoint {name!r} must be a name from model.list",
        )
    for listed_name, path in _iter_checkpoints(models_dir):
        if listed_name == name:
            return path
    hint = str(models_dir)
    raise WorkerError(
        "model_not_found",
        f"mlx checkpoint {name!r} was not found under CORAL_MLX_MODELS_DIR={hint}",
    )


def read_config(path: Path) -> dict[str, Any]:
    config_path = path / "config.json"
    if not config_path.is_file():
        raise WorkerError(
            "model_config_missing",
            f"checkpoint {path} has no config.json",
        )
    try:
        loaded = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise WorkerError("model_config_invalid", f"config.json is not JSON: {exc}") from exc
    if not isinstance(loaded, dict):
        raise WorkerError("model_config_invalid", "config.json must be an object")
    return loaded


def model_info_from_config(config: dict[str, Any]) -> ModelInfo:
    flat = _flatten_config(config)
    architecture = _architecture(flat)
    context_length = _number(
        flat,
        "max_position_embeddings",
        "max_seq_len",
        "max_sequence_length",
        "seq_length",
        "n_positions",
        "model_max_length",
    )
    if context_length is None or context_length <= 0:
        raise WorkerError(
            "model_info_incomplete",
            "config.json has no derivable contextLength (max_position_embeddings)",
        )
    block_count = _number(flat, "num_hidden_layers", "n_layers", "num_layers", "n_layer")
    kv_head_count = _number(
        flat,
        "num_key_value_heads",
        "num_kv_heads",
        "n_kv_heads",
        "num_key_value_heads_per_layer",
    )
    key_length = _number(flat, "head_dim", "qk_nope_head_dim", "attention_key_length")
    if key_length is None:
        hidden = _number(flat, "hidden_size", "n_embd")
        heads = _number(flat, "num_attention_heads", "n_head", "n_heads")
        if hidden and heads:
            key_length = hidden / heads
    value_length = _number(flat, "value_dim", "v_head_dim") or key_length
    values = {
        "contextLength": context_length,
        "architecture": architecture,
        "blockCount": block_count,
        "kvHeadCount": kv_head_count,
        "keyLength": key_length,
        "valueLength": value_length,
    }
    return ModelInfo.model_validate(
        {key: value for key, value in values.items() if value is not None}
    )


def weight_bytes(path: Path) -> int:
    total = 0
    for file in path.rglob("*"):
        if file.is_file() and _is_weight_file(file):
            total += file.stat().st_size
    return total


def peek_thinking_support(path: Path) -> bool | None:
    template_bits: list[str] = []
    for name in ("tokenizer_config.json", "processor_config.json"):
        candidate = path / name
        if not candidate.is_file():
            continue
        try:
            loaded = json.loads(candidate.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if not isinstance(loaded, dict):
            continue
        chat_template = loaded.get("chat_template")
        if isinstance(chat_template, str):
            template_bits.append(chat_template)
        elif isinstance(chat_template, list):
            template_bits.extend(str(item) for item in chat_template)
    chat_file = path / "chat_template.jinja"
    if chat_file.is_file():
        template_bits.append(chat_file.read_text(encoding="utf-8"))
    blob = "\n".join(template_bits)
    if not blob:
        return None
    hints = ("enable_thinking", "<think>", "</think>", "<|channel>thought")
    return any(hint in blob for hint in hints)


def _iter_checkpoints(models_dir: Path) -> list[tuple[str, Path]]:
    root = models_dir.expanduser().resolve()
    if not root.is_dir():
        return []
    found: list[tuple[str, Path]] = []
    if _is_checkpoint(root):
        return [(root.name, root)]
    for path in root.rglob("config.json"):
        checkpoint = path.parent.resolve()
        try:
            relative = checkpoint.relative_to(root)
        except ValueError:
            continue
        if len(relative.parts) > MAX_SCAN_DEPTH:
            continue
        if any(part in SKIP_DIR_NAMES or part.startswith(".") for part in relative.parts):
            continue
        if not _is_checkpoint(checkpoint):
            continue
        found.append((relative.as_posix(), checkpoint))
    found.sort(key=lambda item: item[0])
    return found


def _is_checkpoint(path: Path) -> bool:
    if not path.is_dir() or not (path / "config.json").is_file():
        return False
    return any(file.is_file() and _is_weight_file(file) for file in path.rglob("*"))


def _is_weight_file(path: Path) -> bool:
    name = path.name.lower()
    return name.endswith(WEIGHT_SUFFIXES)


def _modified_at(path: Path) -> str:
    mtimes: list[float] = []
    config = path / "config.json"
    if config.is_file():
        mtimes.append(config.stat().st_mtime)
    for file in path.rglob("*"):
        if file.is_file() and _is_weight_file(file):
            mtimes.append(file.stat().st_mtime)
    stamp = max(mtimes) if mtimes else path.stat().st_mtime
    return datetime.fromtimestamp(stamp, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _flatten_config(config: dict[str, Any]) -> dict[str, Any]:
    flat = dict(config)
    for key in ("text_config", "language_config", "llm_config", "model_config"):
        nested = config.get(key)
        if isinstance(nested, dict):
            for nested_key, value in nested.items():
                flat.setdefault(nested_key, value)
    return flat


def _architecture(flat: dict[str, Any]) -> str | None:
    model_type = flat.get("model_type")
    if isinstance(model_type, str) and model_type:
        key = model_type.strip()
        aliased = ARCH_ALIASES.get(key) or ARCH_ALIASES.get(key.lower())
        if aliased:
            return aliased
        lower = key.lower()
        for prefix in ("gemma4", "gemma3", "gemma2", "gemma", "qwen3", "qwen2"):
            if lower.startswith(prefix):
                return ARCH_ALIASES.get(prefix, prefix)
        return lower
    architectures = flat.get("architectures")
    if isinstance(architectures, list) and architectures:
        first = architectures[0]
        if isinstance(first, str):
            stripped = first.removesuffix("ForCausalLM").removesuffix("ForConditionalGeneration")
            return _architecture({"model_type": stripped})
    return None


def _number(flat: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = flat.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and value > 0:
            return float(value)
    return None
