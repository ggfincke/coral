# protocol/generated/python/handshake.py
# generated Pydantic v2 models from protocol/handshake.schema.json

from __future__ import annotations

from typing import Annotated, Any

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

class HandshakeRequest(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    protocolVersion: Annotated[int, Field(ge=1, le=1)]
    client: Annotated[str, Field(min_length=1)]
    modelsDir: Annotated[str, Field(min_length=1)] = Field(default=None)

class HandshakeVersions(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    python: Annotated[str, Field(min_length=1)]
    mlx: str = Field(default=None)
    mlx_lm: str = Field(default=None)

class HandshakeResult(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    protocolVersion: Annotated[int, Field(ge=1)]
    methods: list[Annotated[str, Field(min_length=1)]]
    versions: HandshakeVersions

HandshakeFrame = Annotated[HandshakeRequest | HandshakeResult, _one_of((HandshakeRequest, HandshakeResult))]
