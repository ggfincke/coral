# packages/coral-sdk/src/coral_sdk/events.py
# typed coral exec events from vendored protocol models; unknown type fails closed

from __future__ import annotations

from pydantic import TypeAdapter, ValidationError

from coral_sdk.errors import CoralProtocolError
from coral_sdk.generated.exec_events import (
    ApprovalRejectedEvent,
    AssistantDeltaEvent,
    CoralExecEvent,
    CoralExecFrame,
    CoralExecResult,
    CoralExecResultUsage,
    DoneEvent,
    DoomLoopStoppedEvent,
    ErrorEvent,
    InitEvent,
    JsonObject,
    McpLaunchRejectedEvent,
    ResultEvent,
    ThinkingDeltaEvent,
    TokenUsage,
    ToolCallEvent,
    ToolResultEvent,
    UsageEvent,
)

# public name for terminal result.usage (snake_case four fields only)
Usage = CoralExecResultUsage

_EVENT_ADAPTER: TypeAdapter[CoralExecEvent] = TypeAdapter(CoralExecEvent)
_FRAME_ADAPTER: TypeAdapter[CoralExecFrame] = TypeAdapter(CoralExecFrame)

# * closed set matching docs/cli.md; extra types are protocol errors
KNOWN_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "init",
        "assistant_delta",
        "thinking_delta",
        "tool_call",
        "tool_result",
        "approval_rejected",
        "mcp_launch_rejected",
        "doom_loop_stopped",
        "usage",
        "done",
        "error",
        "result",
    }
)


def _as_mapping(data: object, what: str) -> dict[str, object]:
    if not isinstance(data, dict):
        raise CoralProtocolError(
            f"{what} is not a JSON object: {type(data).__name__}"
        )
    return data


# fail closed before pydantic so unknown type cannot match extra=allow models
def _reject_unknown_type(data: dict[str, object], *, require_type: bool) -> None:
    if "type" not in data:
        if require_type:
            raise CoralProtocolError("exec event is missing type")
        return
    event_type = data["type"]
    if not isinstance(event_type, str) or event_type not in KNOWN_EVENT_TYPES:
        raise CoralProtocolError(f"unknown exec event type: {event_type!r}")


def parse_event(data: object) -> CoralExecEvent:
    payload = _as_mapping(data, "exec event")
    _reject_unknown_type(payload, require_type=True)
    try:
        return _EVENT_ADAPTER.validate_python(payload)
    except ValidationError as exc:
        raise CoralProtocolError(f"invalid exec event: {exc}") from exc


def parse_frame(data: object) -> CoralExecFrame:
    payload = _as_mapping(data, "exec frame")
    _reject_unknown_type(payload, require_type=False)
    try:
        return _FRAME_ADAPTER.validate_python(payload)
    except ValidationError as exc:
        raise CoralProtocolError(f"invalid exec frame: {exc}") from exc


# drop the stream `type` field so run() returns the result object
def result_from_event(event: ResultEvent) -> CoralExecResult:
    return CoralExecResult.model_validate(
        event.model_dump(exclude={"type"}, exclude_none=True)
    )


__all__ = [
    "ApprovalRejectedEvent",
    "AssistantDeltaEvent",
    "CoralExecEvent",
    "CoralExecFrame",
    "CoralExecResult",
    "CoralExecResultUsage",
    "DoneEvent",
    "DoomLoopStoppedEvent",
    "ErrorEvent",
    "InitEvent",
    "JsonObject",
    "KNOWN_EVENT_TYPES",
    "McpLaunchRejectedEvent",
    "ResultEvent",
    "ThinkingDeltaEvent",
    "TokenUsage",
    "ToolCallEvent",
    "ToolResultEvent",
    "Usage",
    "UsageEvent",
    "parse_event",
    "parse_frame",
    "result_from_event",
]
