# packages/coral-backend/tests/test_messages.py
# leading system messages are joined; git context is never dropped

from __future__ import annotations

import unittest

from coral_backend.messages import coalesce_system_messages
from coral_backend.protocol import ModelRequestMessage


class CoalesceSystemTest(unittest.TestCase):
    def test_joins_two_system_messages_and_keeps_user(self) -> None:
        messages = [
            ModelRequestMessage(role="system", content="you are coral"),
            ModelRequestMessage(role="system", content="git: main dirty"),
            ModelRequestMessage(role="user", content="fix the bug"),
        ]
        out = coalesce_system_messages(messages)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0].role, "system")
        self.assertIn("you are coral", out[0].content)
        self.assertIn("git: main dirty", out[0].content)
        self.assertEqual(out[1].role, "user")
        self.assertEqual(out[1].content, "fix the bug")

    def test_no_system_is_unchanged(self) -> None:
        messages = [ModelRequestMessage(role="user", content="hi")]
        self.assertEqual(coalesce_system_messages(messages)[0].content, "hi")
