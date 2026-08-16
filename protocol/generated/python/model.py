# protocol/generated/python/model.py
# generated Pydantic v2 models from protocol/model.schema.json

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

class Model(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    name: str
    model: str = Field(default=None)
    size: float
    modified_at: str
    digest: str = Field(default=None)

class ModelInfo(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    contextLength: float
    architecture: str = Field(default=None)
    blockCount: float = Field(default=None)
    kvHeadCount: float = Field(default=None)
    keyLength: float = Field(default=None)
    valueLength: float = Field(default=None)
    size: float = Field(default=None)
    digest: str = Field(default=None)

class ModelListRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    modelsDir: Annotated[str, Field(min_length=1)] = Field(default=None)

class ModelShowRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    name: Annotated[str, Field(min_length=1)]

class ModelListResult(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    models: list[Model]

class ModelRef(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    backend: Literal["ollama", "mlx"]
    model: Annotated[str, Field(min_length=1)]
    canonical: Annotated[str, Field(min_length=1)]

ModelProtocol = Annotated[Model | ModelInfo | ModelRef | ModelListRequest | ModelShowRequest | ModelListResult, _one_of((Model, ModelInfo, ModelRef, ModelListRequest, ModelShowRequest, ModelListResult))]
