# packages/coral-sdk/tests/test_integration.py
# gated live coral exec spawn; skipped unless CORAL_BIN is set

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import asyncio
import json
import os
import tempfile
import unittest

from coral_sdk.client import CoralClient
from coral_sdk.events import InitEvent, ResultEvent, Usage

_CORAL_BIN = os.environ.get("CORAL_BIN", "").strip()


class _StubOllama(BaseHTTPRequestHandler):
    # keep the stub quiet during the gated test
    def log_message(self, format: str, *args: object) -> None:
        return

    def _read_json(self) -> dict[str, object]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return payload if isinstance(payload, dict) else {}

    # /api/show plus a one-shot /api/chat NDJSON reply (no tools)
    def do_POST(self) -> None:
        payload = self._read_json()
        path = self.path.split("?", 1)[0].rstrip("/")
        if path.endswith("/api/show"):
            body = json.dumps(
                {
                    "model_info": {
                        "general.architecture": "llama",
                        "llama.context_length": 8192,
                    }
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.endswith("/api/chat"):
            if payload.get("stream") is False or payload.get("keep_alive") == 0:
                body = json.dumps(
                    {"model": payload.get("model", ""), "done": True}
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            chunks = [
                {
                    "model": payload.get("model", ""),
                    "message": {
                        "role": "assistant",
                        "content": "hello from stub",
                    },
                    "done": False,
                },
                {
                    "model": payload.get("model", ""),
                    "message": {"role": "assistant", "content": ""},
                    "done": True,
                    "done_reason": "stop",
                    "prompt_eval_count": 4,
                    "eval_count": 3,
                    "prompt_eval_duration": 1_000_000,
                    "eval_duration": 2_000_000,
                },
            ]
            for chunk in chunks:
                self.wfile.write((json.dumps(chunk) + "\n").encode("utf-8"))
            return
        self.send_response(404)
        self.end_headers()


# bind 127.0.0.1:0 so the gated test does not need a real Ollama
def _start_stub() -> tuple[ThreadingHTTPServer, Thread]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _StubOllama)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


@unittest.skipUnless(_CORAL_BIN, "CORAL_BIN is unset")
class LiveExecTest(unittest.IsolatedAsyncioTestCase):
    async def test_spawn_init_and_result(self) -> None:
        server, _thread = _start_stub()
        host = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            with tempfile.TemporaryDirectory() as tmp:
                cwd = Path(tmp) / "workspace"
                cwd.mkdir()
                home = Path(tmp) / "coral-home"
                home.mkdir()
                result_file = Path(tmp) / "result.json"
                env = dict(os.environ)
                env["CORAL_HOME"] = str(home)
                client = CoralClient(
                    model="stub-model",
                    cwd=cwd,
                    host=host,
                    bin=_CORAL_BIN,
                    result_file=result_file,
                    env=env,
                )

                async def _collect() -> list[object]:
                    async with client:
                        return [
                            event
                            async for event in client.stream("Reply with hi.")
                        ]

                events = await asyncio.wait_for(_collect(), 90)
                self.assertTrue(
                    any(isinstance(event, InitEvent) for event in events)
                )
                results = [
                    event for event in events if isinstance(event, ResultEvent)
                ]
                self.assertEqual(len(results), 1)
                result = results[0]
                self.assertEqual(result.status, "completed")
                self.assertIn("hello from stub", result.response)
                self.assertIsInstance(result.usage, Usage)
                self.assertTrue(result_file.is_file())
                recorded = json.loads(result_file.read_text(encoding="utf-8"))
                self.assertEqual(recorded["run_id"], result.run_id)
                self.assertEqual(recorded["status"], "completed")
                self.assertEqual(recorded["version"], 1)
        finally:
            server.shutdown()
            server.server_close()
