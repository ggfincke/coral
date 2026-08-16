# packages/coral-backend/tests/driver.py
# spawn python -m coral_backend against a fake generate script

from __future__ import annotations

from pathlib import Path
from typing import Any
import json
import os
import select
import subprocess
import sys
import tempfile
import time

REPO_ROOT = Path(__file__).resolve().parents[3]


# stdio client for one worker subprocess using CORAL_FAKE_GENERATE
class WorkerProc:
    def __init__(
        self,
        fake: dict[str, Any],
        *,
        models_dir: Path | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.script_path = Path(self._tmp.name) / "fake.json"
        self.script_path.write_text(json.dumps(fake), encoding="utf-8")
        env = os.environ.copy()
        env["CORAL_FAKE_GENERATE"] = str(self.script_path)
        env["PYTHONUNBUFFERED"] = "1"
        env["CORAL_PROTOCOL_PYTHON"] = str(REPO_ROOT / "protocol" / "generated" / "python")
        src = Path(__file__).resolve().parents[1] / "src"
        env["PYTHONPATH"] = str(src) + os.pathsep + env.get("PYTHONPATH", "")
        if models_dir is not None:
            env["CORAL_MLX_MODELS_DIR"] = str(models_dir)
        if extra_env:
            env.update(extra_env)
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "coral_backend"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=str(REPO_ROOT),
            bufsize=0,
        )
        assert self.proc.stdin is not None
        assert self.proc.stdout is not None
        assert self.proc.stderr is not None
        self._out_buf = bytearray()

    def send(self, frame: dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(frame) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def send_raw(self, data: bytes) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def read(self, timeout: float = 8.0) -> dict[str, Any]:
        line = self._readline(timeout)
        if line is None:
            raise TimeoutError(self._fail("worker produced no stdout frame"))
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise AssertionError(self._fail(f"non-JSON stdout: {line!r}")) from exc
        if not isinstance(parsed, dict):
            raise AssertionError(self._fail(f"stdout frame was not an object: {parsed!r}"))
        return parsed

    def handshake(self, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"protocolVersion": 1, "client": "coral-test"}
        if extra:
            payload.update(extra)
        self.send(
            {
                "v": 1,
                "id": "hs",
                "kind": "request",
                "method": "handshake",
                "payload": payload,
            }
        )
        frame = self.read()
        if frame.get("kind") != "result" or frame.get("method") != "handshake":
            raise AssertionError(self._fail(f"expected handshake result, got {frame!r}"))
        return frame

    def close(self) -> str:
        if self.proc.stdin:
            try:
                self.proc.stdin.close()
            except BrokenPipeError:
                pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=3)
        stderr = ""
        if self.proc.stderr:
            stderr = self.proc.stderr.read().decode("utf-8", errors="replace")
            self.proc.stderr.close()
        if self.proc.stdout:
            self.proc.stdout.close()
        self._tmp.cleanup()
        return stderr

    def _readline(self, timeout: float) -> str | None:
        assert self.proc.stdout is not None
        fd = self.proc.stdout.fileno()
        deadline = time.monotonic() + timeout
        while True:
            nl = self._out_buf.find(b"\n")
            if nl >= 0:
                line = bytes(self._out_buf[:nl])
                del self._out_buf[: nl + 1]
                return line.decode("utf-8")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            ready, _w, _x = select.select([fd], [], [], remaining)
            if not ready:
                return None
            chunk = os.read(fd, 65536)
            if not chunk:
                if self._out_buf:
                    line = bytes(self._out_buf)
                    self._out_buf.clear()
                    return line.decode("utf-8", errors="replace")
                return None
            self._out_buf.extend(chunk)

    def _fail(self, message: str) -> str:
        poll = self.proc.poll()
        stderr = ""
        if self.proc.stderr:
            try:
                ready, _w, _x = select.select([self.proc.stderr], [], [], 0.05)
                if ready:
                    stderr = self.proc.stderr.read().decode("utf-8", errors="replace")
            except Exception:
                stderr = ""
        return f"{message} (exit={poll})\nstderr:\n{stderr}"
