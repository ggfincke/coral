# packages/coral-sdk/tests/test_subprocess.py
# binary discovery, NDJSON parse, and posix exit-code mapping

from __future__ import annotations

from pathlib import Path
import json
import os
import stat
import sys
import tempfile
import unittest

from coral_sdk.errors import CoralBinaryError, CoralProtocolError
from coral_sdk.subprocess import (
    SubprocessTransport,
    discover_coral_command,
    find_coral_checkout,
    normalize_exit_code,
)


class NormalizeExitTest(unittest.TestCase):
    def test_signal_deaths_map_to_128_plus_n(self) -> None:
        self.assertEqual(normalize_exit_code(0), 0)
        self.assertEqual(normalize_exit_code(1), 1)
        self.assertEqual(normalize_exit_code(2), 2)
        self.assertEqual(normalize_exit_code(130), 130)
        self.assertEqual(normalize_exit_code(143), 143)
        self.assertEqual(normalize_exit_code(-2), 130)
        self.assertEqual(normalize_exit_code(-15), 143)


class DiscoverTest(unittest.TestCase):
    def test_explicit_bin_wins(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "coral"
            script.write_text("#!/bin/sh\n", encoding="utf-8")
            script.chmod(script.stat().st_mode | stat.S_IEXEC)
            argv = discover_coral_command(script, env={"PATH": tmp})
        self.assertEqual(argv, [str(script)])

    def test_coral_bin_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "from-env"
            script.write_text("#!/bin/sh\n", encoding="utf-8")
            script.chmod(script.stat().st_mode | stat.S_IEXEC)
            argv = discover_coral_command(
                env={"CORAL_BIN": str(script), "PATH": tmp}
            )
        self.assertEqual(argv, [str(script)])

    def test_js_entry_prefixes_node(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "main.js"
            script.write_text("console.log('ok')\n", encoding="utf-8")
            argv = discover_coral_command(script, env={"PATH": os.environ.get("PATH", "")})
        self.assertEqual(len(argv), 2)
        self.assertTrue(argv[0].endswith("node") or "node" in Path(argv[0]).name)
        self.assertEqual(argv[1], str(script))

    def test_missing_binary_raises(self) -> None:
        from unittest.mock import patch

        with (
            patch("coral_sdk.subprocess.find_coral_checkout", return_value=None),
            patch("coral_sdk.subprocess.shutil.which", return_value=None),
        ):
            with self.assertRaises(CoralBinaryError):
                discover_coral_command(
                    env={"PATH": "/nonexistent-coral-path", "CORAL_BIN": ""}
                )

    def test_checkout_discovery_ignores_process_cwd(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            malicious = Path(tmp)
            (malicious / "src" / "cli").mkdir(parents=True)
            (malicious / "package.json").write_text(
                json.dumps({"name": "coral"}), encoding="utf-8"
            )
            (malicious / "src" / "cli" / "main.tsx").write_text(
                "console.log('malicious')\n", encoding="utf-8"
            )
            previous = Path.cwd()
            os.chdir(malicious)
            try:
                found = find_coral_checkout()
            finally:
                os.chdir(previous)
        self.assertNotEqual(found, malicious)

    def test_ts_entry_never_falls_back_to_npx_download(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "main.tsx"
            script.write_text("console.log('ok')\n", encoding="utf-8")
            with self.assertRaises(CoralBinaryError) as ctx:
                discover_coral_command(script, env={"PATH": "/nonexistent"})
        self.assertIn("tsx not found", str(ctx.exception))
        self.assertNotIn("npx", str(ctx.exception))


class SubprocessNdjsonTest(unittest.IsolatedAsyncioTestCase):
    async def test_parses_ndjson_and_exit_zero(self) -> None:
        payload = {"type": "init", "run_id": "r", "model": "m"}
        transport = SubprocessTransport()
        await transport.start(
            [
                sys.executable,
                "-c",
                "import json,sys;"
                f"sys.stdout.write(json.dumps({payload!r})+'\\n');"
                "sys.stdout.flush()",
            ],
            os.environ,
        )
        events = [event async for event in transport.events()]
        code = await transport.wait()
        self.assertEqual(events, [payload])
        self.assertEqual(code, 0)

    async def test_non_json_line_is_protocol_error(self) -> None:
        transport = SubprocessTransport()
        await transport.start(
            [sys.executable, "-c", "print('not-json')"],
            os.environ,
        )
        with self.assertRaises(CoralProtocolError) as ctx:
            _ = [event async for event in transport.events()]
        self.assertIn("malformed NDJSON", str(ctx.exception))
        await transport.wait()

    async def test_exit_two(self) -> None:
        transport = SubprocessTransport()
        await transport.start(
            [sys.executable, "-c", "raise SystemExit(2)"],
            os.environ,
        )
        _ = [event async for event in transport.events()]
        code = await transport.wait()
        self.assertEqual(code, 2)

    async def test_spawn_missing_binary(self) -> None:
        transport = SubprocessTransport()
        with self.assertRaises(CoralBinaryError):
            await transport.start(
                ["/nonexistent-coral-sdk-bin"],
                os.environ,
            )
