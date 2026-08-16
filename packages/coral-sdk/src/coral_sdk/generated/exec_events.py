# packages/coral-sdk/src/coral_sdk/generated/exec_events.py
# vendored pydantic models from protocol/generated/python/exec_events.py

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, BeforeValidator, TypeAdapter, ValidationError

def _one_of(branches: tuple[Any, ...]) -> BeforeValidator:
    adapters: tuple[TypeAdapter[Any], ...] | None = None

    def validate(value: Any) -> Any:
        nonlocal adapters
        if adapters is None:
            adapters = tuple(TypeAdapter(branch) for branch in branches)
        matches = 0
        for adapter in adapters:
            try:
                adapter.validate_python(value, strict=True)
            except ValidationError:
                continue
            matches += 1
        if matches != 1:
            raise ValueError(
                f"value must match exactly one oneOf branch; matched {matches}"
            )
        return value

    return BeforeValidator(validate)

class TokenUsage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    promptTokens: float
    completionTokens: float
    totalPromptTokens: float
    totalCompletionTokens: float
    contextTokens: float
    promptEvalDurationNs: float = Field(default=None)
    evalDurationNs: float = Field(default=None)
    totalPromptEvalDurationNs: float
    totalEvalDurationNs: float

class CoralExecResultUsage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    prompt_tokens: float
    completion_tokens: float
    prompt_eval_duration_ns: float
    eval_duration_ns: float

class JsonObject(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    pass

class CoralExecResult(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    version: Annotated[int, Field(ge=1, le=1)]
    run_id: Annotated[str, Field(min_length=1)]
    status: Literal["completed", "failed", "cancelled"]
    model: str
    response: str
    usage: CoralExecResultUsage
    error: str = Field(default=None)

class InitEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["init"]
    run_id: Annotated[str, Field(min_length=1)]
    model: str

class AssistantDeltaEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["assistant_delta"]
    text: str
    run_id: Annotated[str, Field(min_length=1)]

class ThinkingDeltaEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["thinking_delta"]
    text: str
    run_id: Annotated[str, Field(min_length=1)]

class ToolCallEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["tool_call"]
    name: str
    args: JsonObject
    call_id: float
    run_id: Annotated[str, Field(min_length=1)]

class ToolResultEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["tool_result"]
    name: str
    output: str
    error: str = Field(default=None)
    call_id: float
    diff: str = Field(default=None)
    run_id: Annotated[str, Field(min_length=1)]

class ApprovalRejectedEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["approval_rejected"]
    name: str
    args: JsonObject
    run_id: Annotated[str, Field(min_length=1)]

class McpLaunchRejectedEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["mcp_launch_rejected"]
    alias: str
    run_id: Annotated[str, Field(min_length=1)]

class DoomLoopStoppedEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["doom_loop_stopped"]
    message: str
    run_id: Annotated[str, Field(min_length=1)]

class UsageEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["usage"]
    usage: TokenUsage
    run_id: Annotated[str, Field(min_length=1)]

class DoneEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["done"]
    run_id: Annotated[str, Field(min_length=1)]

class ErrorEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["error"]
    error: str
    run_id: Annotated[str, Field(min_length=1)]

class ResultEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    type: Literal["result"]
    version: Annotated[int, Field(ge=1, le=1)]
    run_id: Annotated[str, Field(min_length=1)]
    status: Literal["completed", "failed", "cancelled"]
    model: str
    response: str
    usage: CoralExecResultUsage
    error: str = Field(default=None)

CoralExecEvent = Annotated[InitEvent | AssistantDeltaEvent | ThinkingDeltaEvent | ToolCallEvent | ToolResultEvent | ApprovalRejectedEvent | McpLaunchRejectedEvent | DoomLoopStoppedEvent | UsageEvent | DoneEvent | ErrorEvent | ResultEvent, _one_of((InitEvent, AssistantDeltaEvent, ThinkingDeltaEvent, ToolCallEvent, ToolResultEvent, ApprovalRejectedEvent, McpLaunchRejectedEvent, DoomLoopStoppedEvent, UsageEvent, DoneEvent, ErrorEvent, ResultEvent))]

CoralExecFrame = Annotated[CoralExecEvent | CoralExecResult, _one_of((CoralExecEvent, CoralExecResult))]
