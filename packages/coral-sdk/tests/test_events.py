# packages/coral-sdk/tests/test_events.py
# fail-closed unknown types, usage split, and vendored model drift

from __future__ import annotations

from typing import Annotated, get_args, get_origin
from pathlib import Path
import unittest

from coral_sdk.errors import CoralProtocolError
from coral_sdk.events import (
    KNOWN_EVENT_TYPES,
    CoralExecEvent,
    CoralExecResult,
    ResultEvent,
    TokenUsage,
    Usage,
    UsageEvent,
    parse_event,
    parse_frame,
    result_from_event,
)
from coral_sdk.generated import exec_events as vendored

from fakes import repo_root


# skip the two-line file header so a path rewrite is not treated as drift
def _source_body(path_text: str) -> str:
    lines = path_text.splitlines(keepends=True)
    return "".join(lines[2:])


class KnownTypesTest(unittest.TestCase):
    def test_closed_set_matches_generated_union(self) -> None:
        found: set[str] = set()
        event_union = CoralExecEvent
        if get_origin(event_union) is Annotated:
            event_union = get_args(event_union)[0]
        for member in get_args(event_union):
            annotation = member.model_fields["type"].annotation
            found.update(get_args(annotation))
        self.assertEqual(frozenset(found), KNOWN_EVENT_TYPES)


class ParseEventTest(unittest.TestCase):
    def test_unknown_type_fails_closed(self) -> None:
        with self.assertRaises(CoralProtocolError) as ctx:
            parse_event(
                {"type": "token", "text": "hello", "run_id": "run-fixture"}
            )
        self.assertIn("unknown exec event type", str(ctx.exception))

    def test_usage_event_keeps_camelcase_token_usage(self) -> None:
        event = parse_event(
            {
                "type": "usage",
                "run_id": "run-1",
                "usage": {
                    "promptTokens": 12,
                    "completionTokens": 8,
                    "totalPromptTokens": 12,
                    "totalCompletionTokens": 8,
                    "contextTokens": 20,
                    "promptEvalDurationNs": 1_000_000,
                    "evalDurationNs": 2_000_000,
                    "totalPromptEvalDurationNs": 1_000_000,
                    "totalEvalDurationNs": 2_000_000,
                },
            }
        )
        self.assertIsInstance(event, UsageEvent)
        self.assertIsInstance(event.usage, TokenUsage)
        self.assertEqual(event.usage.promptTokens, 12)
        dumped = event.usage.model_dump()
        self.assertIn("promptTokens", dumped)
        self.assertNotIn("prompt_tokens", dumped)

    def test_result_usage_stays_snake_case(self) -> None:
        event = parse_event(
            {
                "type": "result",
                "version": 1,
                "run_id": "run-1",
                "status": "completed",
                "model": "gemma4:31b-mlx",
                "response": "hello",
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 8,
                    "prompt_eval_duration_ns": 1_000_000,
                    "eval_duration_ns": 2_000_000,
                },
            }
        )
        self.assertIsInstance(event, ResultEvent)
        self.assertIsInstance(event.usage, Usage)
        self.assertEqual(event.usage.prompt_tokens, 12)
        dumped = event.usage.model_dump()
        self.assertIn("prompt_tokens", dumped)
        self.assertNotIn("promptTokens", dumped)
        result = result_from_event(event)
        self.assertIsInstance(result, CoralExecResult)
        self.assertNotIn("type", result.model_dump())

    def test_snake_case_usage_on_stream_event_is_rejected(self) -> None:
        with self.assertRaises(CoralProtocolError):
            parse_event(
                {
                    "type": "usage",
                    "run_id": "run-1",
                    "usage": {
                        "prompt_tokens": 12,
                        "completion_tokens": 8,
                        "prompt_eval_duration_ns": 1_000_000,
                        "eval_duration_ns": 2_000_000,
                    },
                }
            )

    def test_bare_result_object_is_a_frame_not_an_event(self) -> None:
        payload = {
            "version": 1,
            "run_id": "run-1",
            "status": "completed",
            "model": "gemma4:31b-mlx",
            "response": "done",
            "usage": {
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "prompt_eval_duration_ns": 0,
                "eval_duration_ns": 0,
            },
        }
        frame = parse_frame(payload)
        self.assertIsInstance(frame, CoralExecResult)
        with self.assertRaises(CoralProtocolError):
            parse_event(payload)


class VendorDriftTest(unittest.TestCase):
    def test_vendored_exec_events_match_protocol_generated_body(self) -> None:
        source = (
            repo_root() / "protocol" / "generated" / "python" / "exec_events.py"
        )
        vendored_path = Path(vendored.__file__).resolve()
        self.assertTrue(source.is_file(), f"missing {source}")
        self.assertEqual(
            _source_body(source.read_text(encoding="utf-8")),
            _source_body(vendored_path.read_text(encoding="utf-8")),
        )
