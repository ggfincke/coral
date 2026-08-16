# packages/coral-backend/src/coral_backend/tools.py
# family-aware tool-call parsers for gemma/qwen; fail closed for others

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import json
import re

from coral_backend.errors import WorkerError

# markers we recognize as tool calls but will not pretend to parse
UNSUPPORTED_MARKERS = (
    "[TOOL_CALLS]",
    "<|tool_calls_section_begin|>",
    "<minimax:tool_call>",
    "<longcat_tool_call>",
    "<|tool_list_start|>",
    "<arg_key>",
)

QWEN_TOOL_START = "<tool_call>"
QWEN_TOOL_END = "</tool_call>"
GEMMA4_TOOL_START = "<|tool_call>"
GEMMA4_TOOL_END = "<tool_call|>"
FUNCTION_GEMMA_START = "<start_function_call>"
FUNCTION_GEMMA_END = "<end_function_call>"

_FUNCTION_RE = re.compile(
    r"<function=(?P<name>[^>\s]+)>(?P<body>.*?)</function>",
    re.DOTALL,
)
_PARAM_RE = re.compile(
    r"<parameter=(?P<key>[^>\s]+)>(?P<value>.*?)</parameter>",
    re.DOTALL,
)
_GEMMA_CALL_RE = re.compile(
    r"(?:call|run)\s+([A-Za-z0-9_.-]+)\s*\((.*)\)\s*$",
    re.DOTALL,
)
_FUNCTION_GEMMA_RE = re.compile(
    r"call:([A-Za-z0-9_.-]+)\{(.*)\}\s*$",
    re.DOTALL,
)
_NAME_RE = re.compile(r'"name"\s*:\s*"((?:\\.|[^"\\])*)"')
_KWARG_RE = re.compile(
    r"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("
    r'"([^"\\]|\\.)*"'
    r"|'([^'\\]|\\.)*'"
    r"|\{.*?\}"
    r"|\[.*?\]"
    r"|[^,]+"
    r")"
)


@dataclass(frozen=True)
class ParsedToolCall:
    """One model tool call with object arguments (Ollama dialect)."""

    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class FamilyDelims:
    """Start/end markers used by the streaming splitter for one family."""

    tool_pairs: tuple[tuple[str, str], ...]
    think_pairs: tuple[tuple[str, str], ...]


FAMILY_DELIMS: dict[str, FamilyDelims] = {
    "qwen": FamilyDelims(
        tool_pairs=((QWEN_TOOL_START, QWEN_TOOL_END),),
        think_pairs=(("<think>", "</think>"),),
    ),
    "qwen3_coder": FamilyDelims(
        tool_pairs=((QWEN_TOOL_START, QWEN_TOOL_END),),
        think_pairs=(("<think>", "</think>"),),
    ),
    "gemma4": FamilyDelims(
        tool_pairs=(
            (GEMMA4_TOOL_START, GEMMA4_TOOL_END),
            (FUNCTION_GEMMA_START, FUNCTION_GEMMA_END),
        ),
        think_pairs=(
            ("<|channel>thought", "<channel|>"),
            ("<think>", "</think>"),
        ),
    ),
    "function_gemma": FamilyDelims(
        tool_pairs=((FUNCTION_GEMMA_START, FUNCTION_GEMMA_END),),
        think_pairs=(("<think>", "</think>"),),
    ),
    "unknown": FamilyDelims(
        tool_pairs=(),
        think_pairs=(("<think>", "</think>"),),
    ),
}

GEMMA_FAMILIES = frozenset({"gemma4", "function_gemma"})
QWEN_FAMILIES = frozenset({"qwen", "qwen3_coder"})
SUPPORTED_FAMILIES = GEMMA_FAMILIES | QWEN_FAMILIES


def detect_family(model_name: str, architecture: str | None = None) -> str:
    blob = f"{architecture or ''} {model_name}".lower().replace("_", "-")
    if "qwen" in blob:
        if "coder" in blob:
            return "qwen3_coder"
        return "qwen"
    if "function-gemma" in blob or "function_gemma" in blob:
        return "function_gemma"
    if "gemma4" in blob or "gemma-4" in blob:
        return "gemma4"
    if "gemma" in blob:
        return "gemma4"
    return "unknown"


def delims_for(family: str) -> FamilyDelims:
    return FAMILY_DELIMS.get(family, FAMILY_DELIMS["unknown"])


def unsupported_marker_in(text: str) -> str | None:
    for marker in UNSUPPORTED_MARKERS:
        if marker in text:
            return marker
    return None


def parse_tool_region(body: str, start_delim: str, family: str) -> list[ParsedToolCall]:
    stripped = body.strip()
    if not stripped:
        return []
    if start_delim in (QWEN_TOOL_START,) or family in QWEN_FAMILIES:
        if "<function=" in stripped:
            return parse_qwen3_coder(stripped)
        return parse_qwen_json(stripped)
    if start_delim == FUNCTION_GEMMA_START or family == "function_gemma":
        return parse_function_gemma(stripped)
    if start_delim == GEMMA4_TOOL_START or family in GEMMA_FAMILIES:
        return parse_gemma4(stripped)
    raise WorkerError(
        "unsupported_tool_family",
        f"tool-call parsing is not implemented for family {family!r}",
    )


def parse_partial_tool_region(
    body: str, start_delim: str, family: str
) -> ParsedToolCall | None:
    if start_delim == FUNCTION_GEMMA_START or family == "function_gemma":
        match = _FUNCTION_GEMMA_RE.search(body)
        if not match:
            if "call:" in body:
                name_m = re.search(r"call:([A-Za-z0-9_.-]+)", body)
                if name_m:
                    return ParsedToolCall(name=name_m.group(1), arguments={})
            return None
        calls = parse_function_gemma(match.group(0))
        return calls[0] if calls else None
    if start_delim == GEMMA4_TOOL_START or family in GEMMA_FAMILIES:
        return _partial_gemma4(body)
    if "<function=" in body:
        calls = parse_qwen3_coder(body + "</function>")
        if calls:
            return calls[0]
        match = re.search(r"<function=([^>\s]+)>", body)
        if match:
            return ParsedToolCall(name=match.group(1), arguments={})
        return None
    return _partial_qwen_json(body)


def parse_qwen_json(body: str) -> list[ParsedToolCall]:
    calls: list[ParsedToolCall] = []
    for obj in _json_objects(body):
        call = _from_json_obj(obj)
        if call is not None:
            calls.append(call)
    if not calls:
        raise WorkerError(
            "tool_parse_failed",
            "qwen tool region was not a JSON object with name and arguments",
        )
    return calls


def parse_qwen3_coder(body: str) -> list[ParsedToolCall]:
    calls: list[ParsedToolCall] = []
    for match in _FUNCTION_RE.finditer(body):
        arguments: dict[str, Any] = {}
        for param in _PARAM_RE.finditer(match.group("body")):
            arguments[param.group("key")] = _coerce_value(param.group("value").strip())
        calls.append(ParsedToolCall(name=match.group("name"), arguments=arguments))
    if not calls:
        raise WorkerError(
            "tool_parse_failed",
            "qwen3_coder tool region had no <function=...> blocks",
        )
    return calls


def parse_gemma4(body: str) -> list[ParsedToolCall]:
    stripped = body.strip()
    try:
        objs = _json_objects(stripped)
    except Exception:
        objs = []
    calls = [call for obj in objs if (call := _from_json_obj(obj)) is not None]
    if calls:
        return calls
    match = _GEMMA_CALL_RE.search(stripped)
    if match:
        return [ParsedToolCall(name=match.group(1), arguments=_parse_kwargs(match.group(2)))]
    raise WorkerError(
        "tool_parse_failed",
        "gemma4 tool region was neither JSON nor call name(...)",
    )


def parse_function_gemma(body: str) -> list[ParsedToolCall]:
    match = _FUNCTION_GEMMA_RE.search(body.strip())
    if not match:
        raise WorkerError(
            "tool_parse_failed",
            "function_gemma tool region was not call:name{k:v}",
        )
    return [ParsedToolCall(name=match.group(1), arguments=_parse_colon_fields(match.group(2)))]


def _partial_qwen_json(body: str) -> ParsedToolCall | None:
    name_m = _NAME_RE.search(body)
    if not name_m:
        return None
    name = json.loads(f'"{name_m.group(1)}"')
    arguments: dict[str, Any] = {}
    args_m = re.search(r'"arguments"\s*:\s*', body)
    if args_m:
        rest = body[args_m.end() :]
        parsed = _try_json_prefix(rest)
        if isinstance(parsed, dict):
            arguments = parsed
        elif isinstance(parsed, str):
            inner = _try_json_prefix(parsed)
            if isinstance(inner, dict):
                arguments = inner
    return ParsedToolCall(name=name, arguments=arguments)


def _partial_gemma4(body: str) -> ParsedToolCall | None:
    stripped = body.strip()
    if not stripped:
        return None
    parsed = _try_json_prefix(stripped)
    if isinstance(parsed, dict):
        call = _from_json_obj(parsed)
        if call is not None:
            return call
    match = _GEMMA_CALL_RE.search(stripped)
    if match:
        return ParsedToolCall(name=match.group(1), arguments=_parse_kwargs(match.group(2)))
    name_m = re.search(r"(?:call|run)\s+([A-Za-z0-9_.-]+)", stripped)
    if name_m:
        return ParsedToolCall(name=name_m.group(1), arguments={})
    name_j = _NAME_RE.search(stripped)
    if name_j:
        return ParsedToolCall(name=json.loads(f'"{name_j.group(1)}"'), arguments={})
    return None


def _from_json_obj(obj: object) -> ParsedToolCall | None:
    if not isinstance(obj, dict):
        return None
    name = obj.get("name")
    arguments: object = obj.get("arguments", obj.get("parameters", {}))
    inner = obj.get("function")
    if isinstance(inner, dict):
        name = inner.get("name", name)
        arguments = inner.get("arguments", arguments)
    if not isinstance(name, str) or not name:
        return None
    if isinstance(arguments, str):
        loaded = _try_json_prefix(arguments)
        arguments = loaded if isinstance(loaded, dict) else {}
    if not isinstance(arguments, dict):
        arguments = {}
    return ParsedToolCall(name=name, arguments=dict(arguments))


def _json_objects(text: str) -> list[object]:
    decoder = json.JSONDecoder()
    objs: list[object] = []
    index = 0
    length = len(text)
    while index < length:
        while index < length and text[index].isspace():
            index += 1
        if index >= length:
            break
        try:
            obj, end = decoder.raw_decode(text, index)
        except json.JSONDecodeError:
            break
        objs.append(obj)
        index = end
    return objs


def _try_json_prefix(text: str) -> object | None:
    stripped = text.lstrip()
    if not stripped:
        return None
    try:
        return json.JSONDecoder().raw_decode(stripped)[0]
    except json.JSONDecodeError:
        pass
    candidate = stripped
    if candidate.startswith("{"):
        opens = candidate.count("{") - candidate.count("}")
        candidate = candidate + ("}" * max(opens, 0))
    elif candidate.startswith("["):
        opens = candidate.count("[") - candidate.count("]")
        candidate = candidate + ("]" * max(opens, 0))
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None


def _coerce_value(raw: str) -> Any:
    if not raw:
        return ""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def _parse_kwargs(raw: str) -> dict[str, Any]:
    arguments: dict[str, Any] = {}
    for match in _KWARG_RE.finditer(raw):
        arguments[match.group(1)] = _coerce_value(match.group(2).strip())
    return arguments


def _parse_colon_fields(raw: str) -> dict[str, Any]:
    arguments: dict[str, Any] = {}
    for part in _split_top_level(raw, ","):
        if ":" not in part:
            continue
        key, value = part.split(":", 1)
        arguments[key.strip()] = _coerce_value(value.strip())
    return arguments


def _split_top_level(raw: str, sep: str) -> list[str]:
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    quote = ""
    for char in raw:
        if quote:
            buf.append(char)
            if char == quote:
                quote = ""
            continue
        if char in {'"', "'"}:
            quote = char
            buf.append(char)
            continue
        if char in "{[":
            depth += 1
        elif char in "}]":
            depth = max(0, depth - 1)
        if char == sep and depth == 0:
            parts.append("".join(buf))
            buf = []
            continue
        buf.append(char)
    if buf:
        parts.append("".join(buf))
    return parts
