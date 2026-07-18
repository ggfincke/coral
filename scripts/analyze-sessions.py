#!/usr/bin/env python3
# scripts/analyze-sessions.py
# report on Coral session and history artifacts

from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))

from coral_dev_tools.analyze_sessions import main


if __name__ == "__main__":
    raise SystemExit(main())
