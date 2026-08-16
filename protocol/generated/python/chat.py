# protocol/generated/python/chat.py
# generated Pydantic v2 models from protocol/chat.schema.json

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

class ChatJsonObject(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    pass

class JsonSchema(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["object"]

class OllamaToolCallFunction(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    index: int = Field(default=None)
    name: str
    arguments: ChatJsonObject

class OllamaToolCall(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["function"] = Field(default=None)
    function: OllamaToolCallFunction

class OllamaToolFunction(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    name: str
    description: str
    parameters: JsonSchema

class OllamaTool(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    type: Literal["function"]
    function: OllamaToolFunction

class AttachmentReportAttached(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    path: str
    truncated: bool

class AttachmentReportSkip(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    path: str
    reason: Literal["not found", "too large", "binary", "unreadable", "outside workspace", "over budget"]

class AttachmentReport(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    attached: list[AttachmentReportAttached]
    skipped: list[AttachmentReportSkip]
    omittedOverBudget: float = Field(default=None)

class ModelRequestMessage(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    role: Literal["system", "user", "assistant", "tool"]
    content: str
    thinking: str = Field(default=None)
    tool_name: str = Field(default=None)
    tool_calls: list[OllamaToolCall] = Field(default=None)

class OllamaMessage(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    role: Literal["system", "user", "assistant", "tool"]
    content: str
    thinking: str = Field(default=None)
    tool_name: str = Field(default=None)
    tool_calls: list[OllamaToolCall] = Field(default=None)
    displayContent: str = Field(default=None)
    attachmentReport: AttachmentReport = Field(default=None)

class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    model: str
    messages: list[ModelRequestMessage]
    tools: list[OllamaTool] = Field(default=None)
    think: ChatThink = Field(default=None)
    keep_alive: ChatKeepAlive = Field(default=None)
    num_ctx: float = Field(default=None)
    num_predict: float = Field(default=None)

class ChatResponse(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    message: OllamaMessage
    done: bool
    prompt_eval_count: float = Field(default=None)
    prompt_eval_duration: float = Field(default=None)
    eval_count: float = Field(default=None)
    eval_duration: float = Field(default=None)

ChatThink = bool | Literal["low", "medium", "high"]

ChatKeepAlive = str | float

ChatProtocol = Annotated[ChatRequest | ChatResponse, _one_of((ChatRequest, ChatResponse))]
