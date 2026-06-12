# scripts/lib/coral_dev_tools/mine_reference.py
# CLI for reference project inventory reports

from __future__ import annotations

import argparse
import json
from pathlib import Path

from coral_dev_tools.reference_inventory import (
    inventory_reference_tree,
    render_markdown,
    render_text,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Inventory local reference projects for Coral design research."
    )
    parser.add_argument(
        "root",
        nargs="?",
        type=Path,
        default=Path("reference"),
        help="Reference directory to scan. Defaults to ./reference.",
    )
    parser.add_argument(
        "--format",
        choices=("text", "md", "json"),
        default="text",
        help="Report format.",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=12,
        help="Maximum rows per ranked section.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report = inventory_reference_tree(args.root.expanduser(), top=max(args.top, 0))
    if args.format == "json":
        print(json.dumps(report.to_json(), indent=2, sort_keys=True))
    elif args.format == "md":
        print(render_markdown(report))
    else:
        print(render_text(report))
    return 1 if report.missing_root else 0


if __name__ == "__main__":
    raise SystemExit(main())
