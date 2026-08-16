# protocol/generated/python/embedding.py
# generated Pydantic v2 models from protocol/embedding.schema.json

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

class EmbedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    model: Annotated[str, Field(min_length=1)]
    texts: list[str]

class EmbedResult(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    vectors: list[list[float]]

EmbeddingProtocol = Annotated[EmbedRequest | EmbedResult, _one_of((EmbedRequest, EmbedResult))]
