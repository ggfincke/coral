# packages/coral-plugins/tests/test_server.py
# in-process and stdio MCP listing plus word_count execution

from __future__ import annotations

from pathlib import Path
import json
import os
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

os.environ.setdefault("OTEL_SDK_DISABLED", "true")

_PROJECT = Path(__file__).resolve().parents[1]
if str(_PROJECT) not in sys.path:
    sys.path.insert(0, str(_PROJECT))

from mcp import Client, StdioServerParameters
from mcp.client.stdio import stdio_client

from coral_plugins.server import (
    _apply_compact_schema,
    build_server,
    load_plugin_module,
    project_root,
)
from coral_plugins.tool import (
    MAX_SCHEMA_CHARS,
    MAX_TOTAL_SCHEMA_CHARS,
    clear_registry,
    schema_char_count,
)
from examples.wordcount import WordCountArgs, count_text_words, word_count


# pull the model-visible text channel out of an MCP CallToolResult
def _text_result(result: object) -> str:
    content = getattr(result, "content", None)
    if not content:
        raise AssertionError(f"tool result had no content: {result!r}")
    first = content[0]
    text = getattr(first, "text", None)
    if not isinstance(text, str):
        raise AssertionError(f"tool result was not text: {first!r}")
    return text


# accept both camelCase wire names and pydantic snake_case attributes
def _input_schema(tool: object) -> dict[str, object]:
    schema = getattr(tool, "inputSchema", None)
    if schema is None:
        schema = getattr(tool, "input_schema", None)
    if not isinstance(schema, dict):
        raise AssertionError(f"tool had no input schema: {tool!r}")
    return schema


class WordCountExampleTest(unittest.TestCase):
    def test_counts_whitespace_words(self) -> None:
        self.assertEqual(count_text_words("one two  three"), 3)

    def test_rejects_relative_path(self) -> None:
        output = word_count(WordCountArgs(path="README.md"))
        self.assertTrue(output.startswith("error: path must be absolute"))

    def test_counts_a_utf8_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.txt"
            path.write_text("alpha beta gamma", encoding="utf-8")
            output = word_count(WordCountArgs(path=str(path)))
        self.assertIn("words: 3", output)
        self.assertIn(str(path), output)


class McpCompatibilityTest(unittest.TestCase):
    def test_private_surface_failure_reports_version_and_remediation(self) -> None:
        class BrokenManager:
            get_tool = None

        broken_server = SimpleNamespace(_tool_manager=BrokenManager())
        tool = SimpleNamespace(name="word_count", schema={})
        with patch(
            "coral_plugins.server.importlib.metadata.version",
            return_value="2.0.0-test",
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"mcp 2\.0\.0-test.*MCPServer\._tool_manager\.get_tool"
                r"\(name\).*mutable dict.*Update Coral's MCP compatibility helper",
            ):
                _apply_compact_schema(broken_server, tool)


class InProcessMcpTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        load_plugin_module("examples.wordcount")

    def tearDown(self) -> None:
        clear_registry()

    async def test_lists_word_count_with_compact_schema(self) -> None:
        mcp = build_server()
        async with Client(mcp, raise_exceptions=True) as client:
            listed = await client.list_tools()
        names = [tool.name for tool in listed.tools]
        self.assertEqual(names, ["word_count"])
        schema = _input_schema(listed.tools[0])
        encoded = json.dumps(schema)
        self.assertNotIn("title", encoded)
        self.assertNotIn("$defs", encoded)
        self.assertEqual(set(schema["properties"]), {"path"})
        chars = schema_char_count(schema)
        self.assertLess(chars, MAX_SCHEMA_CHARS)
        self.assertLess(chars, 2_000)
        self.assertLessEqual(chars, MAX_TOTAL_SCHEMA_CHARS)
        output_schema = getattr(listed.tools[0], "outputSchema", None)
        if output_schema is None:
            output_schema = getattr(listed.tools[0], "output_schema", None)
        self.assertTrue(output_schema in (None, {}))

    async def test_executes_word_count(self) -> None:
        mcp = build_server()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "notes.md"
            path.write_text("hello coral plugins", encoding="utf-8")
            async with Client(mcp, raise_exceptions=True) as client:
                result = await client.call_tool(
                    "word_count", {"path": str(path)}
                )
        text = _text_result(result)
        self.assertIn("words: 3", text)
        self.assertFalse(getattr(result, "isError", False))


class StdioMcpTest(unittest.IsolatedAsyncioTestCase):
    async def test_subprocess_stdio_lists_and_calls(self) -> None:
        root = project_root()
        env = {
            "PATH": os.environ.get("PATH", ""),
            "VIRTUAL_ENV": os.environ.get("VIRTUAL_ENV", ""),
            "OTEL_SDK_DISABLED": "true",
        }
        home = str(Path.home())
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "coral_plugins", "examples.wordcount"],
            env=env,
            cwd=home,
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stdio.txt"
            path.write_text("one two three four", encoding="utf-8")
            async with Client(stdio_client(params), raise_exceptions=True) as client:
                listed = await client.list_tools()
                names = [tool.name for tool in listed.tools]
                self.assertEqual(names, ["word_count"])
                result = await client.call_tool(
                    "word_count", {"path": str(path)}
                )
        self.assertIn("words: 4", _text_result(result))
