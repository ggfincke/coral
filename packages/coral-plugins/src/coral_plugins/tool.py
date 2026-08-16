# packages/coral-plugins/src/coral_plugins/tool.py
# turn pydantic v2 models into compact MCP tool schemas

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from inspect import Parameter, signature
from typing import Any
import json

from pydantic import BaseModel
from pydantic_core import PydanticUndefined

# match src/mcp/manager.ts; operate inside these, do not ask Coral to raise them
MAX_SCHEMA_CHARS = 25_000
MAX_TOTAL_SCHEMA_CHARS = 100_000

_STRIP_KEYS = frozenset({"title", "$schema", "$id", "$comment"})
_DEFS_KEYS = ("$defs", "definitions")

type ToolHandler = Callable[..., Any]


@dataclass(frozen=True)
class RegisteredTool:
    """A function bound to a Pydantic argument model and its compact schema."""

    fn: ToolHandler
    args_model: type[BaseModel]
    name: str
    description: str
    schema: dict[str, Any]


_REGISTRY: list[RegisteredTool] = []


# snapshot of @tool registrations for the current process
def registered_tools() -> tuple[RegisteredTool, ...]:
    return tuple(_REGISTRY)


# tests and load_plugin_module start from an empty registry
def clear_registry() -> None:
    _REGISTRY.clear()


# match JSON.stringify with no extra whitespace (src/mcp/manager.ts schemaSize)
def schema_char_count(schema: dict[str, Any]) -> int:
    encoded = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
    return len(encoded.encode("utf-16-le")) // 2


# inline $defs/$ref and drop verbose title/$schema keys Coral does not need
def compact_json_schema(schema: dict[str, Any]) -> dict[str, Any]:
    defs: dict[str, Any] = {}
    for key in _DEFS_KEYS:
        block = schema.get(key)
        if isinstance(block, dict):
            defs.update(block)
    inlined = _inline_refs(schema, defs, frozenset())
    stripped = _strip_verbose(inlined)
    if not isinstance(stripped, dict):
        raise TypeError("compacted JSON schema must be an object")
    unresolved = _find_refs(stripped)
    if unresolved:
        refs = ", ".join(sorted(unresolved))
        raise ValueError(
            f"recursive or unresolved JSON Schema references are unsupported: {refs}"
        )
    return stripped


def _ref_name(ref: str) -> str | None:
    for prefix in ("#/$defs/", "#/definitions/"):
        if ref.startswith(prefix):
            return ref.removeprefix(prefix)
    return None


def _inline_refs(node: Any, defs: dict[str, Any], seen: frozenset[str]) -> Any:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            name = _ref_name(ref)
            if name is not None and name in defs and name not in seen:
                extras = {key: value for key, value in node.items() if key != "$ref"}
                inlined = _inline_refs(defs[name], defs, seen | {name})
                if extras and isinstance(inlined, dict):
                    merged = {**inlined, **extras}
                    return _inline_refs(merged, defs, seen | {name})
                return inlined
        return {
            key: _inline_refs(value, defs, seen)
            for key, value in node.items()
            if key not in _DEFS_KEYS
        }
    if isinstance(node, list):
        return [_inline_refs(item, defs, seen) for item in node]
    return node


def _strip_verbose(node: Any) -> Any:
    if isinstance(node, dict):
        stripped: dict[str, Any] = {}
        for key, value in node.items():
            if key in _STRIP_KEYS:
                continue
            if key == "properties" and isinstance(value, dict):
                stripped[key] = {
                    property_name: _strip_verbose(property_schema)
                    for property_name, property_schema in value.items()
                }
                continue
            stripped[key] = _strip_verbose(value)
        return stripped
    if isinstance(node, list):
        return [_strip_verbose(item) for item in node]
    return node


def _find_refs(node: Any) -> set[str]:
    if isinstance(node, dict):
        refs = {node["$ref"]} if isinstance(node.get("$ref"), str) else set()
        for value in node.values():
            refs.update(_find_refs(value))
        return refs
    if isinstance(node, list):
        refs: set[str] = set()
        for item in node:
            refs.update(_find_refs(item))
        return refs
    return set()


# fail closed when a single tool would exceed Coral's 25k-char schema cap
def schema_for_model(args_model: type[BaseModel]) -> dict[str, Any]:
    raw = args_model.model_json_schema(mode="validation")
    compact = compact_json_schema(raw)
    chars = schema_char_count(compact)
    if chars > MAX_SCHEMA_CHARS:
        raise ValueError(
            f"{args_model.__name__} schema is {chars} chars; "
            f"Coral skips tools over {MAX_SCHEMA_CHARS} chars "
            f"(src/mcp/manager.ts MAX_SCHEMA_CHARS)"
        )
    return compact


# flatten model fields to top-level MCP arguments ({path} not {args: {path}})
def flatten_handler(fn: ToolHandler, args_model: type[BaseModel]) -> ToolHandler:
    params: list[Parameter] = []
    annotations: dict[str, Any] = {}
    for name, field in args_model.model_fields.items():
        annotation = field.annotation if field.annotation is not None else Any
        annotations[name] = annotation
        if field.is_required():
            params.append(
                Parameter(name, Parameter.KEYWORD_ONLY, annotation=annotation)
            )
            continue
        default: Any = field.default
        if default is PydanticUndefined:
            default = None
        params.append(
            Parameter(
                name,
                Parameter.KEYWORD_ONLY,
                default=default,
                annotation=annotation,
            )
        )

    def handler(**kwargs: Any) -> Any:
        return fn(args_model.model_validate(kwargs))

    handler.__name__ = fn.__name__
    handler.__qualname__ = fn.__qualname__
    handler.__module__ = fn.__module__
    handler.__signature__ = signature(fn).replace(parameters=params, return_annotation=Any)
    handler.__annotations__ = annotations
    return handler


# description is required: function docstrings are forbidden by comment style
def tool(
    args_model: type[BaseModel],
    *,
    name: str | None = None,
    description: str,
) -> Callable[[ToolHandler], ToolHandler]:
    if not isinstance(args_model, type) or not issubclass(args_model, BaseModel):
        raise TypeError("@tool requires a Pydantic v2 BaseModel: @tool(ArgsModel)")
    if not description.strip():
        raise ValueError("@tool requires a nonempty description")

    schema = schema_for_model(args_model)

    def decorator(fn: ToolHandler) -> ToolHandler:
        params = list(signature(fn).parameters.values())
        if not params:
            raise TypeError(
                "@tool functions must accept the Pydantic argument model as the first parameter"
            )
        tool_name = name or fn.__name__
        if any(entry.name == tool_name for entry in _REGISTRY):
            raise ValueError(f"duplicate tool name: {tool_name}")
        total = sum(schema_char_count(entry.schema) for entry in _REGISTRY) + schema_char_count(
            schema
        )
        if total > MAX_TOTAL_SCHEMA_CHARS:
            raise ValueError(
                f"registering {tool_name!r} would use {total} schema chars; "
                f"Coral's session budget is {MAX_TOTAL_SCHEMA_CHARS} "
                f"(src/mcp/manager.ts MAX_TOTAL_SCHEMA_CHARS)"
            )
        _REGISTRY.append(
            RegisteredTool(
                fn=fn,
                args_model=args_model,
                name=tool_name,
                description=description,
                schema=schema,
            )
        )
        return fn

    return decorator
