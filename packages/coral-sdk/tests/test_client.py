# packages/coral-sdk/tests/test_client.py
# recorded-NDJSON CoralClient tests: spawn flags, usage split, cancel trap

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from unittest.mock import patch

from coral_sdk.client import (
    PROFILE_EXCLUDED_TOOLS,
    READ_ONLY_TOOLS,
    WORKSPACE_WRITE_EXTRA_TOOLS,
    CoralClient,
    PermissionProfile,
)
from coral_sdk.errors import (
    CoralBinaryError,
    CoralCancelledError,
    CoralFailedError,
    CoralProtocolError,
    CoralUsageError,
)
from coral_sdk.prompt import plan_prompt as real_plan_prompt
from coral_sdk.events import (
    InitEvent,
    ResultEvent,
    TokenUsage,
    Usage,
    UsageEvent,
)

from fakes import FakeTransport, load_ndjson, recordings_dir


# inject a FakeTransport so these tests never spawn coral
def _client(
    transport: FakeTransport,
    *,
    permission_profile: PermissionProfile = "read-only",
    mcp: bool = False,
    host: str | None = None,
    result_file: str | None = None,
) -> CoralClient:
    return CoralClient(
        model="gemma4:31b-mlx",
        permission_profile=permission_profile,
        mcp=mcp,
        host=host,
        result_file=result_file,
        transport_factory=lambda: transport,
    )


class ProfileCatalogTest(unittest.TestCase):
    def test_read_only_matches_docs(self) -> None:
        self.assertEqual(
            READ_ONLY_TOOLS,
            (
                "read_file",
                "grep",
                "glob",
                "list_files",
                "search_code",
                "skill",
                "code_intel",
                "git_status",
                "git_diff",
                "git_log",
            ),
        )
        self.assertEqual(
            WORKSPACE_WRITE_EXTRA_TOOLS,
            ("write_file", "edit_file", "bash"),
        )
        self.assertEqual(
            PROFILE_EXCLUDED_TOOLS,
            (
                "git_add",
                "git_commit",
                "git_switch",
                "git_push",
                "task",
                "todo_write",
            ),
        )
        overlap = set(READ_ONLY_TOOLS) & set(PROFILE_EXCLUDED_TOOLS)
        self.assertEqual(overlap, set())


class RecordedClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_run_completed_init_and_result(self) -> None:
        transport = FakeTransport(
            load_ndjson(recordings_dir() / "completed.ndjson")
        )
        client = _client(transport)
        result = await client.run("hello")
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.response, "hello")
        self.assertEqual(result.version, 1)
        self.assertIsInstance(result.usage, Usage)
        self.assertEqual(result.usage.prompt_tokens, 12)
        assert transport.argv is not None
        self.assertEqual(transport.argv[0], "coral")
        self.assertIn("exec", transport.argv)
        fmt = transport.argv.index("--output-format")
        self.assertEqual(transport.argv[fmt + 1], "stream-json")
        self.assertIn("--no-mcp", transport.argv)
        self.assertNotIn("--mcp", transport.argv)
        profile = transport.argv.index("--permission-profile")
        self.assertEqual(transport.argv[profile + 1], "read-only")
        self.assertIn("hello", transport.argv)
        self.assertNotIn("--prompt-file", transport.argv)

    async def test_stream_preserves_usage_split(self) -> None:
        transport = FakeTransport(
            load_ndjson(recordings_dir() / "completed.ndjson")
        )
        client = _client(transport)
        events = [event async for event in client.stream("hello")]
        self.assertIsInstance(events[0], InitEvent)
        usage_events = [e for e in events if isinstance(e, UsageEvent)]
        self.assertEqual(len(usage_events), 1)
        self.assertIsInstance(usage_events[0].usage, TokenUsage)
        self.assertEqual(usage_events[0].usage.promptTokens, 12)
        results = [e for e in events if isinstance(e, ResultEvent)]
        self.assertEqual(len(results), 1)
        self.assertIsInstance(results[0].usage, Usage)
        self.assertEqual(results[0].usage.prompt_tokens, 12)

    async def test_cancelled_status_maps_to_cancelled_error(self) -> None:
        transport = FakeTransport(
            load_ndjson(recordings_dir() / "cancelled.ndjson"),
            exit_code=130,
        )
        client = _client(transport)
        with self.assertRaises(CoralCancelledError) as ctx:
            await client.run("hello")
        self.assertEqual(ctx.exception.exit_code, 130)
        self.assertIsNotNone(ctx.exception.result)
        assert ctx.exception.result is not None
        self.assertEqual(ctx.exception.result.status, "cancelled")

    async def test_runerror_beats_cancel(self) -> None:
        transport = FakeTransport(
            load_ndjson(recordings_dir() / "failed-after-cancel.ndjson"),
            exit_code=1,
        )
        client = _client(transport)
        client.cancel()
        with self.assertRaises(CoralFailedError) as ctx:
            await client.run("hello")
        self.assertIsInstance(ctx.exception, CoralFailedError)
        self.assertNotIsInstance(ctx.exception, CoralCancelledError)
        self.assertIn("result file", str(ctx.exception))
        assert ctx.exception.result is not None
        self.assertEqual(ctx.exception.result.status, "failed")

    async def test_unknown_type_in_stream_is_protocol_error(self) -> None:
        transport = FakeTransport(
            [
                '{"type":"init","run_id":"run-1","model":"gemma4:31b-mlx"}',
                '{"type":"token","text":"nope","run_id":"run-1"}',
            ]
        )
        client = _client(transport)
        with self.assertRaises(CoralProtocolError) as ctx:
            await client.run("hello")
        self.assertIn("unknown exec event type", str(ctx.exception))

    async def test_workspace_write_and_mcp_flags(self) -> None:
        transport = FakeTransport(
            load_ndjson(recordings_dir() / "completed.ndjson")
        )
        client = _client(
            transport,
            permission_profile="workspace-write",
            mcp=True,
            host="http://127.0.0.1:11434",
        )
        await client.run("hello")
        assert transport.argv is not None
        profile = transport.argv.index("--permission-profile")
        self.assertEqual(transport.argv[profile + 1], "workspace-write")
        self.assertIn("--mcp", transport.argv)
        self.assertNotIn("--no-mcp", transport.argv)
        host = transport.argv.index("--host")
        self.assertEqual(transport.argv[host + 1], "http://127.0.0.1:11434")

    async def test_prompt_with_shell_metacharacters_stays_one_argv(self) -> None:
        transport = FakeTransport(
            load_ndjson(recordings_dir() / "completed.ndjson")
        )
        client = _client(transport)
        nasty = "hello; rm -rf /"
        await client.run(nasty)
        assert transport.argv is not None
        self.assertIn(nasty, transport.argv)
        joined = " ".join(transport.argv)
        self.assertNotIn("sh -c", joined)

    async def test_result_file_flag(self) -> None:
        transport = FakeTransport(
            load_ndjson(recordings_dir() / "completed.ndjson")
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "result.json")
            client = _client(transport, result_file=path)
            await client.run("hello")
        assert transport.argv is not None
        idx = transport.argv.index("--result-file")
        self.assertEqual(transport.argv[idx + 1], path)

    async def test_empty_model_rejected_before_spawn(self) -> None:
        with self.assertRaises(CoralUsageError):
            CoralClient(model="  ")

    async def test_binary_discovery_failure_removes_forced_prompt_file(self) -> None:
        plans = []

        def capture_plan(prompt: str, *, prompt_file: object):
            plan = real_plan_prompt(prompt, prompt_file=prompt_file)
            plans.append(plan)
            return plan

        with tempfile.TemporaryDirectory() as tmp:
            missing_tsx = os.path.join(tmp, "missing.tsx")
            client = CoralClient(
                model="gemma4:31b-mlx",
                prompt_file=True,
                bin=missing_tsx,
                env={"PATH": "/nonexistent"},
            )
            with (
                patch("coral_sdk.client.plan_prompt", side_effect=capture_plan),
                self.assertRaises(CoralBinaryError),
            ):
                await anext(client.stream("temporary"))
        self.assertEqual(len(plans), 1)
        self.assertIsNotNone(plans[0].temp_file)
        assert plans[0].temp_file is not None
        self.assertFalse(plans[0].temp_file.exists())


class SyncClientTest(unittest.TestCase):
    def test_sync_run_completed(self) -> None:
        transport = FakeTransport(
            load_ndjson(recordings_dir() / "completed.ndjson")
        )
        with CoralClient.sync(
            model="gemma4:31b-mlx",
            transport_factory=lambda: transport,
        ) as client:
            result = client.run("hello")
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.response, "hello")

    def test_sync_context_closes_abandoned_stream_and_prompt_file(self) -> None:
        transport = FakeTransport(
            load_ndjson(recordings_dir() / "completed.ndjson")
        )
        iterator = None
        prompt_path = None
        with CoralClient.sync(
            model="gemma4:31b-mlx",
            prompt_file=True,
            transport_factory=lambda: transport,
        ) as client:
            iterator = client.stream("from a temporary prompt")
            next(iterator)
            assert transport.argv is not None
            index = transport.argv.index("--prompt-file")
            prompt_path = transport.argv[index + 1]
            self.assertTrue(os.path.isfile(prompt_path))
        assert prompt_path is not None
        self.assertFalse(os.path.exists(prompt_path))
        assert iterator is not None
        iterator.close()

    def test_sync_enter_failure_closes_and_resets_event_loop(self) -> None:
        loops: list[asyncio.AbstractEventLoop] = []
        real_new_event_loop = asyncio.new_event_loop

        def new_event_loop() -> asyncio.AbstractEventLoop:
            loop = real_new_event_loop()
            loops.append(loop)
            return loop

        with tempfile.TemporaryDirectory() as tmp:
            client = CoralClient.sync(
                model="gemma4:31b-mlx",
                bin=os.path.join(tmp, "missing.tsx"),
                env={"PATH": "/nonexistent"},
            )
            with (
                patch(
                    "coral_sdk.sync.asyncio.new_event_loop",
                    side_effect=new_event_loop,
                ),
                self.assertRaises(CoralBinaryError),
            ):
                client.__enter__()

        self.assertEqual(len(loops), 1)
        self.assertTrue(loops[0].is_closed())
        self.assertIsNone(client._loop)
