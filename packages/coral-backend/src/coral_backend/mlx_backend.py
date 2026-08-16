# packages/coral-backend/src/coral_backend/mlx_backend.py
# lazy mlx_lm generate wrapper; import mlx only from this module's methods

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
import sys
import threading

from coral_backend.backend import BackendEvent, GenerationBackend
from coral_backend.config import DEFAULT_NUM_PREDICT, NS_PER_SEC
from coral_backend.errors import WorkerError
from coral_backend.messages import think_requested, to_hf_tools, to_template_message
from coral_backend.models import (
    artifact_digest,
    peek_thinking_support,
    read_config,
    resolve_checkpoint,
)
from coral_backend.protocol import ChatRequest
from coral_backend.tools import detect_family


def _import_mlx_lm() -> tuple[object, object]:
    try:
        from mlx_lm import load, stream_generate
    except ImportError as exc:
        raise WorkerError(
            "mlx_unavailable",
            "mlx-lm is not importable. Use standard CPython 3.14 (not 3.14t) on "
            "macOS arm64, then `uv sync` in packages/coral-backend. "
            f"original error: {exc}",
        ) from exc
    return load, stream_generate


class MlxBackend(GenerationBackend):
    """Keep one mlx_lm checkpoint resident and stream tokens through the library API."""

    def __init__(self) -> None:
        self._cache: tuple[str, str, object, object] | None = None
        self._embed_cache: tuple[str, str, object, object] | None = None

    def supports_thinking(self, model: str, models_dir: Path | None) -> bool:
        if models_dir is None:
            return False
        try:
            path = resolve_checkpoint(models_dir, model)
        except WorkerError:
            return False
        peeked = peek_thinking_support(path)
        if peeked is not None:
            return peeked
        tokenizer = self._load(path)[1]
        has_thinking = getattr(tokenizer, "has_thinking", None)
        if isinstance(has_thinking, bool):
            return has_thinking
        return False

    def family_for(self, model: str, models_dir: Path | None) -> str:
        architecture = None
        if models_dir is not None:
            try:
                path = resolve_checkpoint(models_dir, model)
                architecture = read_config(path).get("model_type")
                if not isinstance(architecture, str):
                    architecture = None
            except WorkerError:
                architecture = None
        return detect_family(model, architecture)

    def generate(
        self,
        request: ChatRequest,
        *,
        cancel: threading.Event,
        models_dir: Path | None,
    ) -> Iterator[BackendEvent]:
        if models_dir is None:
            raise WorkerError(
                "models_dir_missing",
                "no MLX models dir; set CORAL_MLX_MODELS_DIR or pass modelsDir on handshake",
            )
        _, stream_generate = _import_mlx_lm()
        path = resolve_checkpoint(models_dir, request.model)
        model, tokenizer = self._load(path)
        if think_requested(request.think) and not self.supports_thinking(request.model, models_dir):
            raise WorkerError(
                "think_unsupported",
                f"model {request.model!r} chat template does not support think; "
                "refusing to silently ignore",
            )
        hf_messages = [to_template_message(message) for message in request.messages]
        template_kwargs: dict[str, object] = {
            "add_generation_prompt": True,
            "tokenize": True,
        }
        if request.tools:
            template_kwargs["tools"] = to_hf_tools(request.tools)
        if request.think is False:
            template_kwargs["enable_thinking"] = False
        elif think_requested(request.think):
            template_kwargs["enable_thinking"] = True
        try:
            prompt = tokenizer.apply_chat_template(hf_messages, **template_kwargs)
        except TypeError as exc:
            if think_requested(request.think) and "enable_thinking" in str(exc):
                raise WorkerError(
                    "think_unsupported",
                    f"model {request.model!r} chat template rejected enable_thinking: {exc}",
                ) from exc
            raise WorkerError("template_error", f"apply_chat_template failed: {exc}") from exc
        prompt_len = _prompt_len(prompt)
        max_tokens = (
            int(request.num_predict) if request.num_predict else DEFAULT_NUM_PREDICT
        )
        step_kwargs: dict[str, object] = {}
        if request.num_ctx:
            num_ctx = int(request.num_ctx)
            if prompt_len > num_ctx:
                raise WorkerError(
                    "num_ctx",
                    f"prompt has {prompt_len} tokens but num_ctx is {num_ctx}",
                )
            step_kwargs["max_kv_size"] = num_ctx
        print(f"coral_backend: generating {request.model} from {path}", file=sys.stderr)
        for response in stream_generate(
            model, tokenizer, prompt, max_tokens=max_tokens, **step_kwargs
        ):
            if cancel.is_set():
                return
            prompt_tokens = float(getattr(response, "prompt_tokens", 0) or 0)
            prompt_tps = float(getattr(response, "prompt_tps", 0) or 0)
            gen_tokens = float(getattr(response, "generation_tokens", 0) or 0)
            gen_tps = float(getattr(response, "generation_tps", 0) or 0)
            yield BackendEvent(
                text=getattr(response, "text", "") or "",
                prompt_eval_count=prompt_tokens,
                prompt_eval_duration=_duration_ns(prompt_tokens, prompt_tps),
                eval_count=gen_tokens,
                eval_duration=_duration_ns(gen_tokens, gen_tps),
                done=getattr(response, "finish_reason", None) is not None,
            )

    def embed(
        self,
        model: str,
        texts: list[str],
        *,
        models_dir: Path | None,
        cancel: threading.Event,
    ) -> list[list[float]]:
        if models_dir is None:
            raise WorkerError(
                "models_dir_missing",
                "no MLX models dir; set CORAL_MLX_MODELS_DIR or pass modelsDir on handshake",
            )
        path = resolve_checkpoint(models_dir, model)
        mlx_model, tokenizer = self._load_embed(path)
        vectors: list[list[float]] = []
        for text in texts:
            if cancel.is_set():
                raise WorkerError("cancelled", "embed cancelled")
            vector = _embed_one(mlx_model, tokenizer, text)
            if cancel.is_set():
                raise WorkerError("cancelled", "embed cancelled")
            vectors.append(vector)
        return vectors

    def _load(self, path: Path) -> tuple[object, object]:
        key = str(path.resolve())
        digest = artifact_digest(path)
        if self._cache is not None and self._cache[:2] == (key, digest):
            if self._embed_cache is not None and self._embed_cache[0] == key:
                self._embed_cache = None
            return self._cache[2], self._cache[3]
        if self._embed_cache is not None and self._embed_cache[:2] == (key, digest):
            self._cache = self._embed_cache
            self._embed_cache = None
            return self._cache[2], self._cache[3]
        if self._embed_cache is not None and self._embed_cache[0] == key:
            self._embed_cache = None
        load, _stream = _import_mlx_lm()
        print(f"coral_backend: loading {path}", file=sys.stderr)
        model, tokenizer = load(str(path))
        self._cache = (key, digest, model, tokenizer)
        return model, tokenizer

    def _load_embed(self, path: Path) -> tuple[object, object]:
        key = str(path.resolve())
        digest = artifact_digest(path)
        if self._embed_cache is not None and self._embed_cache[:2] == (key, digest):
            if self._cache is not None and self._cache[0] == key:
                self._cache = None
            return self._embed_cache[2], self._embed_cache[3]
        if self._cache is not None and self._cache[:2] == (key, digest):
            self._embed_cache = self._cache
            self._cache = None
            return self._embed_cache[2], self._embed_cache[3]
        if self._cache is not None and self._cache[0] == key:
            self._cache = None
        load, _stream = _import_mlx_lm()
        print(f"coral_backend: loading embedding model {path}", file=sys.stderr)
        model, tokenizer = load(str(path))
        self._embed_cache = (key, digest, model, tokenizer)
        return model, tokenizer


def _embed_one(mlx_model: object, tokenizer: object, text: str) -> list[float]:
    import mlx.core as mx

    encode = getattr(tokenizer, "encode", None)
    if not callable(encode):
        raise WorkerError("embed_tokenizer", "embedding tokenizer has no encode()")
    try:
        ids = encode(text)
    except TypeError:
        ids = encode(text, add_special_tokens=True)
    if not isinstance(ids, list) or not ids:
        ids = [0]
    tokens = mx.array(ids)[None]
    body = getattr(mlx_model, "model", None)
    if body is None:
        raise WorkerError(
            "embed_unsupported",
            "this MLX checkpoint has no transformer body for embeddings; "
            "use a raw Qwen3-Embedding (or similar) checkpoint, not mlx-embeddings",
        )
    hidden = body(tokens)
    last = getattr(hidden, "last_hidden_state", hidden)
    if hasattr(last, "mean"):
        pooled = last.mean(axis=1)
    else:
        raise WorkerError("embed_unsupported", "could not mean-pool hidden states")
    norm = mx.linalg.norm(pooled, axis=-1, keepdims=True)
    pooled = pooled / mx.maximum(norm, 1e-12)
    mx.eval(pooled)
    row = pooled[0]
    listed = getattr(row, "tolist", None)
    if not callable(listed):
        raise WorkerError("embed_unsupported", "embedding tensor is not listable")
    values = listed()
    if not isinstance(values, list):
        raise WorkerError("embed_unsupported", "embedding tensor is not a vector")
    return [float(value) for value in values]


def _prompt_len(prompt: object) -> int:
    size = getattr(prompt, "size", None)
    if isinstance(size, int):
        return size
    try:
        return len(prompt)  # type: ignore[arg-type]
    except TypeError:
        return 0


def _duration_ns(tokens: float, tps: float) -> float | None:
    if tokens <= 0 or tps <= 0:
        return None
    return (tokens / tps) * NS_PER_SEC
