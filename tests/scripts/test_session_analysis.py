# tests/scripts/test_session_analysis.py
# unit tests for Python session analysis tooling

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import json
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from coral_dev_tools.session_analysis import analyze_coral_home, render_text


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


class SessionAnalysisTests(unittest.TestCase):
    def test_analyzes_sessions_history_and_integrity(self) -> None:
        with TemporaryDirectory() as raw_dir:
            home = Path(raw_dir)
            sessions_dir = home / "sessions"
            write_json(
                sessions_dir / "index.json",
                {
                    "version": 1,
                    "sessions": [
                        {
                            "id": "abc12345",
                            "model": "gemma4:31b-mlx",
                            "cwd": "/repo",
                            "createdAt": "2026-06-01T00:00:00.000Z",
                            "updatedAt": "2026-06-01T00:00:01.000Z",
                            "title": "Fix bug",
                            "messageCount": 4,
                            "compactionCount": 1,
                        },
                        {
                            "id": "missing",
                            "model": "gemma4:31b-mlx",
                            "cwd": "/repo",
                            "createdAt": "2026-06-01T00:00:00.000Z",
                            "updatedAt": "2026-06-01T00:00:01.000Z",
                            "title": "Missing",
                            "messageCount": 0,
                        },
                    ],
                },
            )
            write_json(
                sessions_dir / "abc12345.json",
                {
                    "meta": {
                        "id": "abc12345",
                        "model": "gemma4:31b-mlx",
                        "cwd": "/repo",
                        "createdAt": "2026-06-01T00:00:00.000Z",
                        "updatedAt": "2026-06-01T00:00:02.000Z",
                        "title": "Fix bug",
                        "messageCount": 4,
                        "compactionCount": 1,
                    },
                    "messages": [
                        {"role": "system", "content": "sys"},
                        {"role": "user", "content": "Fix bug"},
                        {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "function": {
                                        "name": "read_file",
                                        "arguments": {"path": "x"},
                                    }
                                },
                                {
                                    "function": {
                                        "name": "bash",
                                        "arguments": {"command": "npm test"},
                                    }
                                },
                            ],
                        },
                        {
                            "role": "tool",
                            "tool_name": "read_file",
                            "content": "file contents",
                        },
                        {
                            "role": "tool",
                            "tool_name": "bash",
                            "content": "ok" * 100,
                        },
                    ],
                },
            )
            (home / "history.jsonl").write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "text": "Fix bug",
                                "timestamp": 1,
                                "sessionId": "abc12345",
                            }
                        ),
                        json.dumps(
                            {
                                "text": "Fix   bug",
                                "timestamp": 2,
                                "sessionId": None,
                            }
                        ),
                        "{bad",
                    ]
                ),
                encoding="utf-8",
            )

            report = analyze_coral_home(home)

        self.assertEqual(report.session_count, 1)
        self.assertEqual(report.index_count, 2)
        self.assertEqual(report.models["gemma4:31b-mlx"], 1)
        self.assertEqual(report.tool_counts["read_file"], 1)
        self.assertEqual(report.tool_counts["bash"], 1)
        self.assertEqual(report.sessions[0].risky_tool_calls, 1)
        self.assertEqual(report.sessions[0].compaction_count, 1)
        self.assertEqual(report.history.entry_count, 2)
        self.assertEqual(report.history.corrupt_lines, 1)
        self.assertEqual(report.history.repeated_prompts, [("Fix bug", 2)])
        self.assertTrue(any("missing" in issue.message for issue in report.issues))

        rendered = render_text(report, show_prompts=True)
        self.assertIn("Coral session analysis", rendered)
        self.assertIn("Fix bug", rendered)

if __name__ == "__main__":
    unittest.main()
