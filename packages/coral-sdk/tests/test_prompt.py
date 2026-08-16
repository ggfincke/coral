# packages/coral-sdk/tests/test_prompt.py
# positional vs prompt-file helper and the 1 MiB pre-spawn cap

from __future__ import annotations

from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

from coral_sdk.errors import CoralUsageError
from coral_sdk.prompt import (
    ARGV_PROMPT_MAX_BYTES,
    MAX_PROMPT_BYTES,
    cleanup_prompt_plan,
    plan_prompt,
    prompt_byte_length,
)


class PlanPromptTest(unittest.TestCase):
    def test_small_prompt_is_positional(self) -> None:
        plan = plan_prompt("hello coral")
        self.assertEqual(plan.positional, "hello coral")
        self.assertIsNone(plan.prompt_file)
        self.assertIsNone(plan.temp_file)

    def test_empty_prompt_is_usage_error(self) -> None:
        with self.assertRaises(CoralUsageError):
            plan_prompt("   \n")

    def test_over_cap_is_usage_error_before_spawn(self) -> None:
        huge = "x" * (MAX_PROMPT_BYTES + 1)
        self.assertGreater(prompt_byte_length(huge), MAX_PROMPT_BYTES)
        with self.assertRaises(CoralUsageError) as ctx:
            plan_prompt(huge)
        self.assertIn(str(MAX_PROMPT_BYTES), str(ctx.exception))

    def test_force_file_writes_temp_utf8(self) -> None:
        plan = plan_prompt("from file", prompt_file=True)
        try:
            self.assertIsNone(plan.positional)
            self.assertIsNotNone(plan.prompt_file)
            self.assertEqual(plan.temp_file, plan.prompt_file)
            assert plan.prompt_file is not None
            self.assertEqual(
                plan.prompt_file.read_text(encoding="utf-8"), "from file"
            )
        finally:
            cleanup_prompt_plan(plan)
            if plan.prompt_file is not None:
                self.assertFalse(plan.prompt_file.exists())

    def test_explicit_path_is_kept(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "prompt.txt"
            plan = plan_prompt("saved", prompt_file=dest)
            self.assertEqual(plan.prompt_file, dest)
            self.assertIsNone(plan.temp_file)
            self.assertEqual(dest.read_text(encoding="utf-8"), "saved")
            cleanup_prompt_plan(plan)
            self.assertTrue(dest.exists())

    def test_over_argv_threshold_uses_file(self) -> None:
        text = "y" * (ARGV_PROMPT_MAX_BYTES + 1)
        plan = plan_prompt(text)
        try:
            self.assertIsNone(plan.positional)
            self.assertIsNotNone(plan.prompt_file)
        finally:
            cleanup_prompt_plan(plan)

    def test_auto_tempfile_is_removed_when_write_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "prompt.txt"
            fd = os.open(dest, os.O_CREAT | os.O_WRONLY, 0o600)
            with (
                patch(
                    "coral_sdk.prompt.tempfile.mkstemp",
                    return_value=(fd, str(dest)),
                ),
                patch.object(Path, "write_text", side_effect=OSError("disk full")),
                self.assertRaisesRegex(OSError, "disk full"),
            ):
                plan_prompt("from file", prompt_file=True)
            self.assertFalse(dest.exists())
