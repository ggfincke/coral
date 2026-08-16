# packages/coral-backend/tests/test_tools.py
# gemma/qwen tool-call parsers and unsupported-family honesty

from __future__ import annotations

import unittest

from coral_backend.errors import WorkerError
from coral_backend.stream import OutputSplitter
from coral_backend.tools import (
    detect_family,
    parse_function_gemma,
    parse_gemma4,
    parse_qwen3_coder,
    parse_qwen_json,
)


class FamilyDetectTest(unittest.TestCase):
    def test_qwen_and_gemma_from_name_and_arch(self) -> None:
        self.assertEqual(detect_family("qwen3-coder", "qwen3"), "qwen3_coder")
        self.assertEqual(detect_family("demo", "qwen3"), "qwen")
        self.assertEqual(detect_family("gemma4-31b", None), "gemma4")
        self.assertEqual(detect_family("mistral-medium", "mistral3"), "unknown")


class QwenParserTest(unittest.TestCase):
    def test_json_object_arguments(self) -> None:
        calls = parse_qwen_json(
            '{"name": "read_file", "arguments": {"path": "README.md"}}'
        )
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].name, "read_file")
        self.assertEqual(calls[0].arguments["path"], "README.md")

    def test_qwen3_coder_xml(self) -> None:
        body = (
            "<function=read_file>\n"
            "<parameter=path>src/main.ts</parameter>\n"
            "</function>"
        )
        calls = parse_qwen3_coder(body)
        self.assertEqual(calls[0].name, "read_file")
        self.assertEqual(calls[0].arguments["path"], "src/main.ts")


class GemmaParserTest(unittest.TestCase):
    def test_gemma4_call_form(self) -> None:
        calls = parse_gemma4('call read_file(path="AGENTS.md")')
        self.assertEqual(calls[0].name, "read_file")
        self.assertEqual(calls[0].arguments["path"], "AGENTS.md")

    def test_function_gemma_call_form(self) -> None:
        calls = parse_function_gemma("call:read_file{path:README.md}")
        self.assertEqual(calls[0].name, "read_file")
        self.assertEqual(calls[0].arguments["path"], "README.md")


class SplitterTest(unittest.TestCase):
    def test_qwen_stream_assigns_index_on_every_partial(self) -> None:
        splitter = OutputSplitter("qwen")
        deltas = []
        text = (
            "hi\n<tool_call>\n"
            '{"name": "read_file", "arguments": {"path": "a.txt"}}\n'
            "</tool_call>"
        )
        for char in text:
            deltas.extend(splitter.feed(char))
        deltas.extend(splitter.finish())
        tool_deltas = [delta for delta in deltas if delta.tool_calls]
        self.assertGreaterEqual(len(tool_deltas), 1)
        for delta in tool_deltas:
            function = delta.tool_calls[0]["function"]
            self.assertEqual(function["index"], 0)
            self.assertEqual(function["name"], "read_file")
        self.assertEqual(tool_deltas[-1].tool_calls[0]["function"]["arguments"]["path"], "a.txt")

    def test_unknown_family_refuses_foreign_tool_markup(self) -> None:
        splitter = OutputSplitter("unknown")
        with self.assertRaises(WorkerError) as ctx:
            splitter.feed("[TOOL_CALLS] read_file")
            splitter.finish()
        self.assertEqual(ctx.exception.code, "unsupported_tool_family")
