#!/usr/bin/env python3
# scripts/mine-reference.py
# inventory local reference projects for Coral design research

from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))

from coral_dev_tools.mine_reference import main


if __name__ == "__main__":
    raise SystemExit(main())
