# packages/coral-plugins/tests/test_tool.py
# compact schema size, $defs inlining, and @tool registration

from __future__ import annotations

import json
import unittest

from pydantic import BaseModel, Field

from coral_plugins.tool import (
    MAX_SCHEMA_CHARS,
    MAX_TOTAL_SCHEMA_CHARS,
    clear_registry,
    compact_json_schema,
    registered_tools,
    schema_char_count,
    schema_for_model,
    tool,
)


class Inner(BaseModel):
    n: int = Field(description="count")


class Outer(BaseModel):
    inner: Inner
    label: str = Field(description="label")


class ToolDecoratorTest(unittest.TestCase):
    def setUp(self) -> None:
        clear_registry()

    def tearDown(self) -> None:
        clear_registry()

    def test_compact_schema_strips_titles_and_inlines_defs(self) -> None:
        raw = Outer.model_json_schema()
        self.assertIn("$defs", raw)
        compact = compact_json_schema(raw)
        encoded = json.dumps(compact)
        self.assertNotIn("$defs", compact)
        self.assertNotIn("title", encoded)
        self.assertNotIn("$ref", encoded)
        inner = compact["properties"]["inner"]
        self.assertEqual(inner["type"], "object")
        self.assertEqual(inner["properties"]["n"]["type"], "integer")
        self.assertLess(schema_char_count(compact), schema_char_count(raw))

    def test_compact_schema_preserves_a_property_named_title(self) -> None:
        class TitledArgs(BaseModel):
            title: str = Field(description="user-provided title")

        compact = schema_for_model(TitledArgs)

        self.assertEqual(compact["required"], ["title"])
        self.assertEqual(compact["properties"]["title"]["type"], "string")
        self.assertNotIn("title", compact["properties"]["title"])

    def test_schema_for_model_stays_under_per_tool_cap(self) -> None:
        schema = schema_for_model(Outer)
        self.assertLess(schema_char_count(schema), MAX_SCHEMA_CHARS)
        self.assertLess(schema_char_count(schema), 2_000)

    def test_oversized_schema_fails_closed(self) -> None:
        class Huge(BaseModel):
            x: str = Field(description="y" * (MAX_SCHEMA_CHARS + 100))

        with self.assertRaises(ValueError) as raised:
            schema_for_model(Huge)
        self.assertIn("MAX_SCHEMA_CHARS", str(raised.exception))

    def test_schema_size_uses_json_stringify_utf16_units(self) -> None:
        description = "😀" * 13_000
        encoded = json.dumps(
            {"description": description}, ensure_ascii=False, separators=(",", ":")
        )
        self.assertEqual(
            schema_char_count({"description": description}),
            len(encoded.encode("utf-16-le")) // 2,
        )

        class AstralDescription(BaseModel):
            x: str = Field(description=description)

        with self.assertRaises(ValueError):
            schema_for_model(AstralDescription)

    def test_recursive_schema_fails_closed_without_dangling_refs(self) -> None:
        class Node(BaseModel):
            children: list[Node] = []

        with self.assertRaises(ValueError) as raised:
            schema_for_model(Node)
        self.assertIn("recursive", str(raised.exception))

    def test_tool_registers_flattened_name_and_schema(self) -> None:
        class Args(BaseModel):
            path: str = Field(description="absolute path")

        @tool(Args, description="echo the path")
        def echo_path(args: Args) -> str:
            return args.path

        tools = registered_tools()
        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0].name, "echo_path")
        self.assertEqual(set(tools[0].schema["properties"]), {"path"})
        self.assertNotIn("args", tools[0].schema.get("properties", {}))
        self.assertLess(schema_char_count(tools[0].schema), MAX_SCHEMA_CHARS)
        self.assertLessEqual(
            sum(schema_char_count(entry.schema) for entry in tools),
            MAX_TOTAL_SCHEMA_CHARS,
        )

    def test_tool_requires_pydantic_model(self) -> None:
        with self.assertRaises(TypeError):
            tool(object, description="nope")  # type: ignore[arg-type]

    def test_duplicate_names_fail_closed(self) -> None:
        class Args(BaseModel):
            n: int

        @tool(Args, description="first")
        def twice(args: Args) -> str:
            return str(args.n)

        with self.assertRaises(ValueError):

            @tool(Args, description="second")
            def twice(args: Args) -> str:
                return str(args.n)
