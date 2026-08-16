# packages/coral-backend/src/coral_backend/fake.py
# scripted generation backend injected via CORAL_FAKE_GENERATE

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any
import hashlib
import json
import math
import os
import threading
import time

from coral_backend.backend import BackendEvent, GenerationBackend
from coral_backend.config import FAKE_CAPTURE_ENV, FAKE_GENERATE_ENV
from coral_backend.errors import WorkerError
from coral_backend.messages import think_requested
from coral_backend.protocol import ChatRequest
from coral_backend.tools import detect_family


class FakeBackend(GenerationBackend):
    """Replay a JSON script so stdio tests never load mlx or checkpoints."""

    def __init__(self, script_path: Path) -> None:
        self.script_path = script_path

    @classmethod
    def from_env(cls) -> FakeBackend:
        raw = os.environ.get(FAKE_GENERATE_ENV)
        if not raw:
            raise RuntimeError(f"{FAKE_GENERATE_ENV} is empty")
        return cls(Path(raw))

    def supports_thinking(self, model: str, models_dir: Path | None) -> bool:
        return bool(self._script().get("supports_thinking", False))

    def family_for(self, model: str, models_dir: Path | None) -> str:
        script = self._script()
        configured = script.get("family")
        if isinstance(configured, str) and configured:
            return configured
        return detect_family(model)

    def generate(
        self,
        request: ChatRequest,
        *,
        cancel: threading.Event,
        models_dir: Path | None,
    ) -> Iterator[BackendEvent]:
        script = self._script()
        self._capture(request)
        if think_requested(request.think) and not script.get("supports_thinking", False):
            raise WorkerError(
                "think_unsupported",
                f"model {request.model!r} chat template does not support think; "
                "refusing to silently ignore",
            )
        metrics = {
            "prompt_eval_count": script.get("prompt_eval_count", 1),
            "prompt_eval_duration": script.get("prompt_eval_duration", 1_000_000),
            "eval_count": script.get("eval_count", 1),
            "eval_duration": script.get("eval_duration", 2_000_000),
        }
        raw = script.get("raw")
        if isinstance(raw, str):
            yield from self._stream_raw(raw, script, cancel, metrics)
            return
        chunks = script.get("chunks")
        if not isinstance(chunks, list):
            chunks = []
        for chunk in chunks:
            if cancel.is_set():
                return
            if not isinstance(chunk, dict):
                continue
            delay_ms = chunk.get("delay_ms", script.get("delay_ms", 0))
            _sleep_cancellable(delay_ms, cancel)
            if cancel.is_set():
                return
            yield _chunk_event(chunk, metrics, done=False)
        yield BackendEvent(done=True, **metrics)

    def _stream_raw(
        self,
        raw: str,
        script: dict[str, Any],
        cancel: threading.Event,
        metrics: dict[str, Any],
    ) -> Iterator[BackendEvent]:
        size = int(script.get("chunk_chars") or 24)
        delay_ms = script.get("delay_ms", 0)
        for start in range(0, len(raw), max(size, 1)):
            if cancel.is_set():
                return
            _sleep_cancellable(delay_ms, cancel)
            if cancel.is_set():
                return
            yield BackendEvent(text=raw[start : start + size])
        yield BackendEvent(done=True, **metrics)

    def embed(
        self,
        model: str,
        texts: list[str],
        *,
        models_dir: Path | None,
        cancel: threading.Event,
    ) -> list[list[float]]:
        del model, models_dir
        script = self._script()
        configured = script.get("embed")
        embed_cfg = configured if isinstance(configured, dict) else {}
        explicit = embed_cfg.get("vectors")
        if isinstance(explicit, list) and len(explicit) == len(texts):
            return [_coerce_vector(item) for item in explicit]
        dims = int(embed_cfg.get("dimensions") or 8)
        if dims <= 0:
            raise WorkerError("embed_dims", "fake embed dimensions must be > 0")
        vectors: list[list[float]] = []
        for text in texts:
            if cancel.is_set():
                raise WorkerError("cancelled", "embed cancelled")
            _sleep_opaque(embed_cfg.get("opaque_delay_ms", 0))
            if cancel.is_set():
                raise WorkerError("cancelled", "embed cancelled")
            _sleep_cancellable(embed_cfg.get("delay_ms", 0), cancel)
            if cancel.is_set():
                raise WorkerError("cancelled", "embed cancelled")
            vectors.append(_hash_vector(text, dims))
        return vectors

    def _script(self) -> dict[str, Any]:
        loaded = json.loads(self.script_path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise WorkerError("fake_script", "CORAL_FAKE_GENERATE must be a JSON object")
        return loaded

    def _capture(self, request: ChatRequest) -> None:
        dest = os.environ.get(FAKE_CAPTURE_ENV)
        if not dest:
            return
        payload = request.model_dump(exclude_none=True)
        Path(dest).write_text(json.dumps(payload), encoding="utf-8")


def create_backend() -> FakeBackend:
    return FakeBackend.from_env()


def _chunk_event(chunk: dict[str, Any], metrics: dict[str, Any], *, done: bool) -> BackendEvent:
    raw = chunk.get("raw")
    if isinstance(raw, str):
        return BackendEvent(text=raw, done=done)
    normalized: dict[str, Any] | None = None
    content = chunk.get("content")
    thinking = chunk.get("thinking")
    tool_calls = chunk.get("tool_calls")
    if content is not None or thinking is not None or tool_calls is not None:
        message: dict[str, Any] = {"role": "assistant", "content": content or ""}
        if thinking:
            message["thinking"] = thinking
        if tool_calls:
            message["tool_calls"] = [
                _normalize_scripted_call(call) for call in tool_calls if isinstance(call, dict)
            ]
        normalized = {"message": message, "done": False}
    return BackendEvent(text="", normalized=normalized, done=done)


def _normalize_scripted_call(call: dict[str, Any]) -> dict[str, Any]:
    function = call.get("function")
    if isinstance(function, dict):
        index = function.get("index", call.get("index", 0))
        name = function.get("name", "")
        arguments = function.get("arguments", {})
    else:
        index = call.get("index", 0)
        name = call.get("name", "")
        arguments = call.get("arguments", {})
    if not isinstance(arguments, dict):
        arguments = {}
    return {
        "type": "function",
        "function": {
            "index": int(index),
            "name": str(name),
            "arguments": arguments,
        },
    }


def _hash_vector(text: str, dims: int) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    values = [((digest[index % 32] / 127.5) - 1.0) for index in range(dims)]
    norm = math.sqrt(sum(value * value for value in values)) or 1.0
    return [value / norm for value in values]


def _coerce_vector(item: object) -> list[float]:
    if not isinstance(item, list):
        raise WorkerError("embed_script", "fake embed vectors must be number arrays")
    values: list[float] = []
    for value in item:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise WorkerError("embed_script", "fake embed vectors must be number arrays")
        values.append(float(value))
    return values


def _sleep_cancellable(delay_ms: object, cancel: threading.Event) -> None:
    try:
        remaining = float(delay_ms) / 1000.0
    except (TypeError, ValueError):
        return
    deadline = time.monotonic() + max(remaining, 0.0)
    while True:
        if cancel.is_set():
            return
        left = deadline - time.monotonic()
        if left <= 0:
            return
        cancel.wait(timeout=min(left, 0.02))


def _sleep_opaque(delay_ms: object) -> None:
    try:
        delay = float(delay_ms) / 1000.0
    except (TypeError, ValueError):
        return
    time.sleep(max(delay, 0.0))
