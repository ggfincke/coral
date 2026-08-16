# packages/coral-backend/src/coral_backend/chat.py
# chat.start: mlx_lm generate -> Ollama-dialect ChatResponse events

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path
import threading

from coral_backend.backend import BackendEvent, GenerationBackend
from coral_backend.errors import WorkerError
from coral_backend.messages import coalesce_system_messages, think_requested
from coral_backend.protocol import ChatRequest, ChatResponse, OllamaMessage
from coral_backend.stream import OutputSplitter
from coral_backend.tools import SUPPORTED_FAMILIES

EmitFn = Callable[[ChatResponse], None]


def run_chat(
    request: ChatRequest,
    backend: GenerationBackend,
    *,
    cancel: threading.Event,
    models_dir: Path | None,
    emit: EmitFn,
) -> dict[str, object]:
    coalesced = request.model_copy(
        update={"messages": coalesce_system_messages(list(request.messages))}
    )
    family = backend.family_for(coalesced.model, models_dir)
    if coalesced.tools and family not in SUPPORTED_FAMILIES:
        raise WorkerError(
            "unsupported_tool_family",
            f"tool-call parsing is implemented for gemma/qwen only; "
            f"got family {family!r} for model {coalesced.model!r}",
        )
    if think_requested(coalesced.think) and not backend.supports_thinking(
        coalesced.model, models_dir
    ):
        raise WorkerError(
            "think_unsupported",
            f"model {coalesced.model!r} chat template does not support think; "
            "refusing to silently ignore",
        )
    splitter = OutputSplitter(family=family)
    metrics: dict[str, float] = {}
    for event in backend.generate(coalesced, cancel=cancel, models_dir=models_dir):
        if cancel.is_set():
            break
        _absorb_metrics(metrics, event)
        for response in _event_responses(event, splitter):
            emit(response)
        if event.done:
            break
    if cancel.is_set():
        return {"cancelled": True}
    for delta in splitter.finish():
        emit(_delta_response(delta, done=False))
    emit(_done_response(metrics))
    return {}


def _event_responses(event: BackendEvent, splitter: OutputSplitter) -> Iterator[ChatResponse]:
    if event.normalized is not None:
        yield ChatResponse.model_validate({**event.normalized, "done": False})
        return
    if event.text:
        for delta in splitter.feed(event.text):
            yield _delta_response(delta, done=False)


def _delta_response(delta: object, *, done: bool) -> ChatResponse:
    content = getattr(delta, "content", "") or ""
    thinking = getattr(delta, "thinking", None)
    tool_calls = getattr(delta, "tool_calls", None)
    message: dict[str, object] = {"role": "assistant", "content": content}
    if thinking:
        message["thinking"] = thinking
    if tool_calls:
        message["tool_calls"] = tool_calls
    return ChatResponse.model_validate({"message": message, "done": done})


def _done_response(metrics: dict[str, float]) -> ChatResponse:
    payload: dict[str, object] = {
        "message": OllamaMessage(role="assistant", content=""),
        "done": True,
    }
    for key in (
        "prompt_eval_count",
        "prompt_eval_duration",
        "eval_count",
        "eval_duration",
    ):
        value = metrics.get(key)
        if value is not None:
            payload[key] = value
    return ChatResponse.model_validate(payload)


def _absorb_metrics(metrics: dict[str, float], event: BackendEvent) -> None:
    for key in (
        "prompt_eval_count",
        "prompt_eval_duration",
        "eval_count",
        "eval_duration",
    ):
        value = getattr(event, key)
        if value is not None:
            metrics[key] = float(value)
