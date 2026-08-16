# protocol/generated/python/envelope.py
# generated Pydantic v2 models from protocol/envelope.schema.json

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

class EnvelopePayload(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    pass

class EnvelopeErrorPayload(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    message: Annotated[str, Field(min_length=1)]
    code: Annotated[str, Field(min_length=1)] = Field(default=None)

class EnvelopeRequest(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    v: Annotated[int, Field(ge=1, le=1)]
    id: Annotated[str, Field(min_length=1)]
    kind: Literal["request"]
    method: Annotated[str, Field(min_length=1)]
    payload: EnvelopePayload

class EnvelopeEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    v: Annotated[int, Field(ge=1, le=1)]
    id: Annotated[str, Field(min_length=1)]
    kind: Literal["event"]
    method: Annotated[str, Field(min_length=1)]
    payload: EnvelopePayload

class EnvelopeResult(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    v: Annotated[int, Field(ge=1, le=1)]
    id: Annotated[str, Field(min_length=1)]
    kind: Literal["result"]
    method: Annotated[str, Field(min_length=1)]
    payload: EnvelopePayload

class EnvelopeCancel(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    v: Annotated[int, Field(ge=1, le=1)]
    id: Annotated[str, Field(min_length=1)]
    kind: Literal["cancel"]

class EnvelopeError(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    v: Annotated[int, Field(ge=1, le=1)]
    id: Annotated[str, Field(min_length=1)]
    kind: Literal["error"]
    method: Annotated[str, Field(min_length=1)] = Field(default=None)
    payload: EnvelopeErrorPayload

Envelope = Annotated[EnvelopeRequest | EnvelopeEvent | EnvelopeResult | EnvelopeCancel | EnvelopeError, _one_of((EnvelopeRequest, EnvelopeEvent, EnvelopeResult, EnvelopeCancel, EnvelopeError))]
