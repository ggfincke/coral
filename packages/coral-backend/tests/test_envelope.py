# packages/coral-backend/tests/test_envelope.py
# subprocess envelope loop: handshake, cancel, malformed, over-limit, unknown method

from __future__ import annotations

from pathlib import Path
import json
import tempfile
import unittest

from coral_backend.config import MAX_FRAME_BYTES, PHASE2_METHODS
from driver import WorkerProc


class EnvelopeLoopTest(unittest.TestCase):
    def test_handshake_advertises_embed(self) -> None:
        worker = WorkerProc(_plain_fake())
        try:
            frame = worker.handshake()
            payload = frame["payload"]
            self.assertEqual(payload["protocolVersion"], 1)
            self.assertEqual(payload["methods"], list(PHASE2_METHODS))
            self.assertIn("embed", payload["methods"])
            self.assertIn("python", payload["versions"])
        finally:
            worker.close()

    def test_unknown_method_is_error_and_process_stays_up(self) -> None:
        worker = WorkerProc(_plain_fake())
        try:
            worker.handshake()
            worker.send(
                {
                    "v": 1,
                    "id": "bad",
                    "kind": "request",
                    "method": "nope",
                    "payload": {},
                }
            )
            err = worker.read()
            self.assertEqual(err["kind"], "error")
            self.assertEqual(err["id"], "bad")
            self.assertEqual(err["payload"]["code"], "unknown_method")
            worker.send(
                {
                    "v": 1,
                    "id": "list",
                    "kind": "request",
                    "method": "model.list",
                    "payload": {},
                }
            )
            listed = worker.read()
            self.assertEqual(listed["kind"], "result")
            self.assertEqual(listed["method"], "model.list")
        finally:
            worker.close()

    def test_malformed_json_kills_request_not_process(self) -> None:
        worker = WorkerProc(_plain_fake())
        try:
            worker.handshake()
            worker.send_raw(b"not-json\n")
            err = worker.read()
            self.assertEqual(err["kind"], "error")
            self.assertEqual(err["payload"]["code"], "malformed_frame")
            worker.send(
                {
                    "v": 1,
                    "id": "list",
                    "kind": "request",
                    "method": "model.list",
                    "payload": {},
                }
            )
            listed = worker.read()
            self.assertEqual(listed["kind"], "result")
        finally:
            worker.close()

    def test_oversized_frame_kills_request_not_process(self) -> None:
        worker = WorkerProc(_plain_fake())
        try:
            worker.handshake()
            worker.send_raw(b"x" * (MAX_FRAME_BYTES + 8) + b"\n")
            err = worker.read()
            self.assertEqual(err["kind"], "error")
            self.assertEqual(err["payload"]["code"], "over_limit")
            worker.send(
                {
                    "v": 1,
                    "id": "list",
                    "kind": "request",
                    "method": "model.list",
                    "payload": {},
                }
            )
            listed = worker.read()
            self.assertEqual(listed["kind"], "result")
        finally:
            worker.close()

    def test_unknown_kind_is_schema_failure(self) -> None:
        worker = WorkerProc(_plain_fake())
        try:
            worker.handshake()
            worker.send({"v": 1, "id": "req-1", "kind": "stream"})
            err = worker.read()
            self.assertEqual(err["kind"], "error")
            self.assertIn(err["payload"]["code"], {"schema_failure", "malformed_frame"})
            worker.send(
                {
                    "v": 1,
                    "id": "list",
                    "kind": "request",
                    "method": "model.list",
                    "payload": {},
                }
            )
            self.assertEqual(worker.read()["kind"], "result")
        finally:
            worker.close()

    def test_handshake_must_be_first(self) -> None:
        worker = WorkerProc(_plain_fake())
        try:
            worker.send(
                {
                    "v": 1,
                    "id": "early",
                    "kind": "request",
                    "method": "model.list",
                    "payload": {},
                }
            )
            err = worker.read()
            self.assertEqual(err["kind"], "error")
            self.assertEqual(err["payload"]["code"], "handshake_required")
            worker.handshake()
        finally:
            worker.close()


class ChatStreamTest(unittest.TestCase):
    def test_streams_content_thinking_and_indexed_tool_calls(self) -> None:
        fake = {
            "supports_thinking": True,
            "family": "qwen",
            "prompt_eval_count": 12,
            "prompt_eval_duration": 1_000_000,
            "eval_count": 8,
            "eval_duration": 2_000_000,
            "chunks": [
                {"content": "Looking "},
                {"thinking": "need the file"},
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "name": "read_file",
                            "arguments": {},
                        }
                    ]
                },
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "name": "read_file",
                            "arguments": {"path": "README.md"},
                        }
                    ]
                },
            ],
        }
        worker = WorkerProc(fake)
        try:
            worker.handshake()
            worker.send(_chat_request("req-chat", "hello"))
            events = _collect_chat(worker, "req-chat")
            contents = [event["payload"]["message"].get("content", "") for event in events]
            think = [
                event["payload"]["message"].get("thinking")
                for event in events
                if event["payload"]["message"].get("thinking")
            ]
            self.assertIn("Looking ", contents)
            self.assertEqual(think, ["need the file"])
            tool_events = [
                event
                for event in events
                if event["payload"]["message"].get("tool_calls")
            ]
            self.assertGreaterEqual(len(tool_events), 2)
            for event in tool_events:
                call = event["payload"]["message"]["tool_calls"][0]["function"]
                self.assertEqual(call["index"], 0)
                self.assertEqual(call["name"], "read_file")
                self.assertIsInstance(call["arguments"], dict)
            final = events[-1]
            self.assertTrue(final["payload"]["done"])
            self.assertEqual(final["payload"]["prompt_eval_count"], 12)
            self.assertEqual(final["payload"]["prompt_eval_duration"], 1_000_000)
            self.assertEqual(final["payload"]["eval_count"], 8)
            self.assertEqual(final["payload"]["eval_duration"], 2_000_000)
        finally:
            worker.close()

    def test_raw_qwen_tool_call_assigns_index(self) -> None:
        fake = {
            "family": "qwen",
            "raw": (
                "I'll look.\n<tool_call>\n"
                '{"name": "read_file", "arguments": {"path": "README.md"}}\n'
                "</tool_call>\n"
            ),
            "chunk_chars": 16,
            "prompt_eval_count": 3,
            "prompt_eval_duration": 1000,
            "eval_count": 4,
            "eval_duration": 2000,
        }
        worker = WorkerProc(fake)
        try:
            worker.handshake()
            worker.send(_chat_request("req-raw", "read it", tools=True))
            events = _collect_chat(worker, "req-raw")
            tool_events = [
                event
                for event in events
                if event["payload"]["message"].get("tool_calls")
            ]
            self.assertGreaterEqual(len(tool_events), 1)
            last_call = tool_events[-1]["payload"]["message"]["tool_calls"][0]["function"]
            self.assertEqual(last_call["index"], 0)
            self.assertEqual(last_call["name"], "read_file")
            self.assertEqual(last_call["arguments"]["path"], "README.md")
        finally:
            worker.close()

    def test_cancel_stops_mid_stream(self) -> None:
        fake = {
            "chunks": [
                {"content": "one", "delay_ms": 20},
                {"content": "two", "delay_ms": 800},
                {"content": "three", "delay_ms": 800},
            ],
            "prompt_eval_count": 1,
            "prompt_eval_duration": 1,
            "eval_count": 1,
            "eval_duration": 1,
        }
        worker = WorkerProc(fake)
        try:
            worker.handshake()
            worker.send(_chat_request("c1", "go"))
            first = worker.read()
            self.assertEqual(first["kind"], "event")
            self.assertIn("one", first["payload"]["message"].get("content", ""))
            worker.send({"v": 1, "id": "c1", "kind": "cancel"})
            frames = []
            while True:
                frame = worker.read(timeout=4.0)
                frames.append(frame)
                if frame.get("kind") in {"result", "error"}:
                    break
            texts = [
                frame.get("payload", {}).get("message", {}).get("content", "")
                for frame in frames
                if frame.get("kind") == "event"
            ]
            self.assertNotIn("two", texts)
            self.assertNotIn("three", texts)
            terminal = frames[-1]
            self.assertEqual(terminal["kind"], "result")
            self.assertTrue(terminal["payload"].get("cancelled"))
        finally:
            worker.close()

    def test_think_unsupported_fails_the_request(self) -> None:
        worker = WorkerProc({"supports_thinking": False, "chunks": [{"content": "nope"}]})
        try:
            worker.handshake()
            worker.send(
                {
                    "v": 1,
                    "id": "t1",
                    "kind": "request",
                    "method": "chat.start",
                    "payload": {
                        "model": "demo",
                        "messages": [{"role": "user", "content": "hi"}],
                        "think": True,
                    },
                }
            )
            err = worker.read()
            self.assertEqual(err["kind"], "error")
            self.assertEqual(err["payload"]["code"], "think_unsupported")
            worker.send(_chat_request("ok", "hi"))
            events = _collect_chat(worker, "ok")
            self.assertTrue(events[-1]["payload"]["done"])
        finally:
            worker.close()

    def test_coalesces_second_system_message(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            capture = Path(tmp) / "capture.json"
            worker = WorkerProc(
                {"chunks": [{"content": "ok"}]},
                extra_env={"CORAL_FAKE_CAPTURE": str(capture)},
            )
            try:
                worker.handshake()
                worker.send(
                    {
                        "v": 1,
                        "id": "sys",
                        "kind": "request",
                        "method": "chat.start",
                        "payload": {
                            "model": "demo",
                            "messages": [
                                {"role": "system", "content": "you are coral"},
                                {"role": "system", "content": "git: main"},
                                {"role": "user", "content": "hi"},
                            ],
                        },
                    }
                )
                _collect_chat(worker, "sys")
            finally:
                worker.close()
            captured = json.loads(capture.read_text(encoding="utf-8"))
            roles = [message["role"] for message in captured["messages"]]
            self.assertEqual(roles, ["system", "user"])
            self.assertIn("you are coral", captured["messages"][0]["content"])
            self.assertIn("git: main", captured["messages"][0]["content"])


def _plain_fake() -> dict[str, object]:
    return {"chunks": [{"content": "ok"}]}


def _chat_request(request_id: str, content: str, *, tools: bool = False) -> dict[str, object]:
    payload: dict[str, object] = {
        "model": "demo",
        "messages": [{"role": "user", "content": content}],
        "num_ctx": 8192,
        "num_predict": 128,
    }
    if tools:
        payload["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "read a file",
                    "parameters": {"type": "object"},
                },
            }
        ]
    return {
        "v": 1,
        "id": request_id,
        "kind": "request",
        "method": "chat.start",
        "payload": payload,
    }


def _collect_chat(worker: WorkerProc, request_id: str) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    while True:
        frame = worker.read()
        self_id = frame.get("id")
        if self_id != request_id:
            raise AssertionError(f"unexpected id {self_id} for {request_id}: {frame!r}")
        if frame.get("kind") == "event":
            events.append(frame)
            continue
        if frame.get("kind") == "error":
            raise AssertionError(f"chat failed: {frame!r}")
        if frame.get("kind") == "result":
            return events
        raise AssertionError(f"unexpected frame {frame!r}")
