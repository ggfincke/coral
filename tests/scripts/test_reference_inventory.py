# tests/scripts/test_reference_inventory.py
# unit tests for Python reference inventory tooling

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from coral_dev_tools.reference_inventory import inventory_reference_tree


class ReferenceInventoryTests(unittest.TestCase):
    def test_scans_reference_tree_for_design_signals(self) -> None:
        with TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            project = root / "opencode"
            project.mkdir()
            (project / "system-prompt.ts").write_text(
                "export const prompt = 'You are a coding agent';\n"
                "const command = '/compact';\n",
                encoding="utf-8",
            )
            (project / "tools.ts").write_text(
                "export const tool = { name: 'read_file' };\n"
                "const shape = 'tool_calls';\n",
                encoding="utf-8",
            )
            (project / "permission.ts").write_text(
                "export const policy = 'approval permission sandbox';\n",
                encoding="utf-8",
            )

            report = inventory_reference_tree(root)

        self.assertFalse(report.missing_root)
        self.assertEqual(report.file_count, 3)
        self.assertEqual(report.project_counts["opencode"], 3)
        self.assertEqual(report.slash_commands["/compact"], 1)
        self.assertEqual(report.tool_names["read_file"], 1)
        self.assertTrue(report.prompt_files)
        self.assertTrue(report.tool_files)
        self.assertTrue(report.permission_files)

if __name__ == "__main__":
    unittest.main()
