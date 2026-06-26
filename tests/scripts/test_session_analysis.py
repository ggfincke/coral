# tests/scripts/test_session_analysis.py
# focused regressions for Coral session analysis tooling

from __future__ import annotations

from collections import Counter
from pathlib import Path
import hashlib
import json
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "lib"))

from coral_dev_tools.analyze_sessions import render_report
from coral_dev_tools.session_analysis import AnalysisReport, HistorySummary


def make_report() -> AnalysisReport:
    prompt = "repeat this private prompt"
    return AnalysisReport(
        home=Path("/tmp/coral"),
        sessions_dir=Path("/tmp/coral/sessions"),
        index_path=Path("/tmp/coral/sessions/index.json"),
        index_count=0,
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

    def test_json_can_include_repeated_prompts_when_requested(self) -> None:
        output = render_report(
            make_report(),
            output_format="json",
            top=8,
            show_prompts=True,
        )
        item = json.loads(output)["history"]["repeatedPrompts"][0]

        self.assertEqual(
            item,
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

    def test_text_can_include_repeated_prompts_when_requested(self) -> None:
        output = render_report(
            make_report(),
            output_format="text",
            top=8,
            show_prompts=True,
        )

        self.assertIn("repeat this private prompt", output)


if __name__ == "__main__":
    unittest.main()
