# tests/scripts/test_session_analysis.py
# test Coral session analysis output contracts

from __future__ import annotations

from collections import Counter
from pathlib import Path
import hashlib
import json
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "lib"))

from coral_dev_tools.analyze_sessions import render_report
from coral_dev_tools.session_analysis import (
    AnalysisReport,
    HistorySummary,
    LoadedSession,
    analyze_coral_home,
    metrics_for_session,
)


def make_report() -> AnalysisReport:
    prompt = "repeat this private prompt"
    return AnalysisReport(
        home=Path("/tmp/coral"),
        sessions_dir=Path("/tmp/coral/sessions"),
        session_count=0,
        history=HistorySummary(
            path="/tmp/coral/history.jsonl",
            entry_count=2,
            corrupt_lines=0,
            session_linked_entries=0,
            repeated_prompts=[(prompt, 2)],
        ),
        sessions=[],
        models=Counter(),
        cwd_counts=Counter(),
        tool_counts=Counter(),
        role_counts=Counter(),
        issues=[],
    )


class SessionAnalysisJsonTest(unittest.TestCase):
    def test_json_redacts_repeated_prompts_by_default(self) -> None:
        output = render_report(
            make_report(),
            output_format="json",
            top=8,
            show_prompts=False,
        )
        item = json.loads(output)["history"]["repeatedPrompts"][0]

        self.assertNotIn("text", item)
        self.assertEqual(item["count"], 2)
        self.assertEqual(item["length"], len("repeat this private prompt"))
        self.assertEqual(
            item["digest"],
            "sha256:"
            + hashlib.sha256(b"repeat this private prompt").hexdigest(),
        )

        shown = render_report(
            make_report(),
            output_format="json",
            top=8,
            show_prompts=True,
        )
        shown_item = json.loads(shown)["history"]["repeatedPrompts"][0]
        self.assertEqual(
            shown_item,
            {"text": "repeat this private prompt", "count": 2},
        )


class SessionAnalysisTextTest(unittest.TestCase):
    # default text output is the common path — redaction must hold there too
    def test_text_redacts_repeated_prompts_by_default(self) -> None:
        output = render_report(
            make_report(),
            output_format="text",
            top=8,
            show_prompts=False,
        )
        digest = hashlib.sha256(b"repeat this private prompt").hexdigest()[:10]

        self.assertNotIn("repeat this private prompt", output)
        self.assertIn(f"prompt:{digest}", output)
        self.assertIn("pass --show-prompts", output)

        shown = render_report(
            make_report(),
            output_format="text",
            top=8,
            show_prompts=True,
        )
        self.assertIn("repeat this private prompt", shown)


class SessionAnalysisToolPolicyTest(unittest.TestCase):
    def test_mixed_tool_names_use_runtime_default_gated_semantics(self) -> None:
        names = [
            "read_file",
            "bash",
            "mcp__fixture__echo",
            "future_tool",
        ]
        messages = [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "type": "function",
                        "function": {"name": name, "arguments": {}},
                    }
                    for name in names
                ],
            },
            *[
                {"role": "tool", "tool_name": name, "content": "ok"}
                for name in names
            ],
        ]
        session = LoadedSession(
            path=Path("/tmp/fixture.json"),
            meta={
                "id": "fixture",
                "title": "fixture",
                "model": "test-model",
                "cwd": "/tmp",
                "updatedAt": "2026-07-17T00:00:00.000Z",
                "messageCount": len(messages),
            },
            messages=messages,
        )

        metrics, issues = metrics_for_session(session, Counter(), Counter())

        self.assertEqual(issues, [])
        self.assertEqual(metrics.tool_calls, 4)
        self.assertEqual(metrics.default_gated_tool_calls, 3)
        self.assertEqual(metrics.to_json()["defaultGatedToolCalls"], 3)
        self.assertNotIn("riskyToolCalls", metrics.to_json())


class SessionAnalysisDiscoveryTest(unittest.TestCase):
    def test_exact_session_files_override_stale_legacy_index(self) -> None:
        with tempfile.TemporaryDirectory(prefix="coral-session-analysis-") as raw:
            home = Path(raw)
            sessions_dir = home / "sessions"
            sessions_dir.mkdir()
            index_path = sessions_dir / "index.json"
            index_bytes = json.dumps(
                {"version": 1, "sessions": [{"id": "ffffffff"}]}
            )
            index_path.write_text(index_bytes, encoding="utf-8")
            (sessions_dir / "deadbeef.json").write_text(
                json.dumps(
                    {
                        "meta": {
                            "id": "deadbeef",
                            "title": "authoritative session",
                            "model": "test-model",
                            "cwd": "/tmp/workspace",
                            "updatedAt": "2026-07-18T00:00:00.000Z",
                            "messageCount": 1,
                        },
                        "messages": [
                            {"role": "system", "content": "System"},
                            {"role": "user", "content": "Prompt"},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            (sessions_dir / "not-a-session.json").write_text(
                "{",
                encoding="utf-8",
            )

            report = analyze_coral_home(home)

            self.assertEqual(report.session_count, 1)
            self.assertEqual(
                [session.session_id for session in report.sessions],
                ["deadbeef"],
            )
            self.assertEqual(index_path.read_text(encoding="utf-8"), index_bytes)


if __name__ == "__main__":
    unittest.main()
