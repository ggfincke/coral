# packages/coral-plugins/src/coral_plugins/server.py
# stdio MCP server entry for python -m coral_plugins

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from types import ModuleType
import importlib
import importlib.metadata
import os
import sys

# mcp 2.x enables OpenTelemetry by default; keep stdio stdout protocol-only
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

from mcp.server import MCPServer

from coral_plugins.tool import (
    MAX_TOTAL_SCHEMA_CHARS,
    RegisteredTool,
    clear_registry,
    flatten_handler,
    registered_tools,
    schema_char_count,
)

USAGE = "usage: python -m coral_plugins <module>"
SERVER_NAME = "coral-plugins"
_MISSING = object()
_MCP_SCHEMA_SURFACE = (
    "MCPServer._tool_manager.get_tool(name) returning a bound tool with "
    "mutable dict .parameters"
)
SERVER_INSTRUCTIONS = (
    "Coral Python plugin server. MCP cwd is always $HOME (Coral launchCwd), "
    "never the workspace. Tools that read project files take an explicit "
    "absolute path argument. Do not write CORAL_HOME state files. "
    "File-mutating tools are forbidden until a host-mediated patch pathway exists."
)


# walk up from this file to the uv project that owns examples/
def project_root() -> Path:
    here = Path(__file__).resolve()
    for candidate in [here.parent, *here.parents]:
        if (candidate / "pyproject.toml").is_file() and (candidate / "examples").is_dir():
            return candidate
    return here.parents[2]


# * MCP cwd is $HOME, so examples.* cannot be imported from cwd
def ensure_project_on_path() -> Path:
    root = project_root()
    root_s = str(root)
    if root_s not in sys.path:
        sys.path.insert(0, root_s)
    return root


# import a plugin module against the project root, not MCP cwd
def load_plugin_module(module_name: str) -> ModuleType:
    ensure_project_on_path()
    clear_registry()
    stale = [
        key
        for key in list(sys.modules)
        if key == module_name or key.startswith(f"{module_name}.")
    ]
    for key in stale:
        del sys.modules[key]
    return importlib.import_module(module_name)


# explain SDK drift at the one private compatibility boundary
def _mcp_schema_compatibility_error(reason: str) -> RuntimeError:
    try:
        sdk_version = importlib.metadata.version("mcp")
    except importlib.metadata.PackageNotFoundError:
        sdk_version = "unavailable"
    return RuntimeError(
        f"Coral compact-schema compatibility failure (mcp {sdk_version}): "
        f"{reason}. Expected private surface: {_MCP_SCHEMA_SURFACE}. "
        "Update Coral's MCP compatibility helper for this MCP version."
    )


# overwrite the SDK-generated schema after add_tool so titles/$defs stay gone
def _apply_compact_schema(mcp: MCPServer, tool: RegisteredTool) -> None:
    try:
        manager = getattr(mcp, "_tool_manager", None)
    except Exception as exc:
        raise _mcp_schema_compatibility_error(
            "MCPServer._tool_manager could not be inspected"
        ) from exc
    if manager is None:
        raise _mcp_schema_compatibility_error(
            "MCPServer._tool_manager is unavailable"
        )
    try:
        get_tool = getattr(manager, "get_tool", None)
    except Exception as exc:
        raise _mcp_schema_compatibility_error(
            "MCPServer._tool_manager.get_tool could not be inspected"
        ) from exc
    if not callable(get_tool):
        raise _mcp_schema_compatibility_error(
            "MCPServer._tool_manager.get_tool is missing or not callable"
        )
    try:
        bound = get_tool(tool.name)
    except Exception as exc:
        raise _mcp_schema_compatibility_error(
            f"MCPServer._tool_manager.get_tool({tool.name!r}) failed"
        ) from exc
    if bound is None:
        raise _mcp_schema_compatibility_error(
            f"MCPServer._tool_manager.get_tool({tool.name!r}) returned no tool"
        )
    try:
        parameters = getattr(bound, "parameters", _MISSING)
    except Exception as exc:
        raise _mcp_schema_compatibility_error(
            f"bound tool {tool.name!r} parameters could not be inspected"
        ) from exc
    if parameters is _MISSING:
        raise _mcp_schema_compatibility_error(
            f"bound tool {tool.name!r} has no parameters field"
        )
    if not isinstance(parameters, dict):
        raise _mcp_schema_compatibility_error(
            f"bound tool {tool.name!r} parameters is not a dict"
        )
    try:
        bound.parameters = tool.schema
    except Exception as exc:
        raise _mcp_schema_compatibility_error(
            f"bound tool {tool.name!r} parameters is not assignable"
        ) from exc
    try:
        applied = getattr(bound, "parameters", _MISSING)
    except Exception as exc:
        raise _mcp_schema_compatibility_error(
            f"bound tool {tool.name!r} parameters could not be verified"
        ) from exc
    if applied is _MISSING or not isinstance(applied, dict):
        raise _mcp_schema_compatibility_error(
            f"bound tool {tool.name!r} parameters changed to a non-dict"
        )
    if applied != tool.schema:
        raise _mcp_schema_compatibility_error(
            f"bound tool {tool.name!r} parameters changed after assignment"
        )


# register flattened handlers and overwrite parameters with compact schemas
def bind_tools(mcp: MCPServer, tools: Sequence[RegisteredTool] | None = None) -> None:
    entries = tuple(tools) if tools is not None else registered_tools()
    total = sum(schema_char_count(entry.schema) for entry in entries)
    if total > MAX_TOTAL_SCHEMA_CHARS:
        raise ValueError(
            f"plugin schemas total {total} chars; Coral's session budget is "
            f"{MAX_TOTAL_SCHEMA_CHARS} (src/mcp/manager.ts MAX_TOTAL_SCHEMA_CHARS)"
        )
    for entry in entries:
        handler = flatten_handler(entry.fn, entry.args_model)
        # skip output schemas: Coral counts them toward the same 25k/100k caps
        mcp.add_tool(
            handler,
            name=entry.name,
            description=entry.description,
            structured_output=False,
        )
        _apply_compact_schema(mcp, entry)


# construct an MCPServer with the current @tool registry (stdio via .run())
def build_server(
    *,
    name: str = SERVER_NAME,
    tools: Sequence[RegisteredTool] | None = None,
) -> MCPServer:
    mcp = MCPServer(
        name,
        instructions=SERVER_INSTRUCTIONS,
        log_level="WARNING",
        warn_on_duplicate_tools=True,
    )
    bind_tools(mcp, tools)
    return mcp


# python -m coral_plugins <module> -> stdio MCP server
def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in {"-h", "--help"}:
        print(USAGE, file=sys.stderr)
        return 0 if args and args[0] in {"-h", "--help"} else 2
    if args[0].startswith("-"):
        print(f"error: unknown option {args[0]}\n{USAGE}", file=sys.stderr)
        return 2
    if len(args) != 1:
        print(f"error: expected one module name\n{USAGE}", file=sys.stderr)
        return 2

    load_plugin_module(args[0])
    if not registered_tools():
        print(
            f"error: module {args[0]!r} registered no @tool functions",
            file=sys.stderr,
        )
        return 2

    build_server().run()
    return 0
