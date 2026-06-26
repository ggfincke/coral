# scripts/lib/coral_dev_tools/analyze_sessions.py
# CLI for session/history analysis reports

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from coral_dev_tools.session_analysis import (
    AnalysisReport,
    analyze_coral_home,
    render_markdown,
    render_text,
)


def default_coral_home() -> Path:
    env_home = os.environ.get("CORAL_HOME")
    if env_home:
        return Path(env_home).expanduser()
    return Path.home() / ".coral"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Analyze Coral session JSON and prompt history files."
    )
    parser.add_argument(
        "--home",
        type=Path,
        default=default_coral_home(),
        help="Coral home directory. Defaults to CORAL_HOME or ~/.coral.",
    )
    parser.add_argument(
        "--sessions-dir",
        type=Path,
        default=None,
        help="Override the sessions directory. Defaults to <home>/sessions.",
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
        default=8,
        help="Maximum rows per ranked section.",
    )
    parser.add_argument(
        "--show-prompts",
        action="store_true",
        help="Show repeated prompt text from history.jsonl.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit non-zero when integrity issues are found.",
    )
    return parser


def render_report(
    report: AnalysisReport,
    *,
    output_format: str,
    top: int,
    show_prompts: bool,
) -> str:
    if output_format == "json":
        return json.dumps(
            report.to_json(show_prompts=show_prompts),
            indent=2,
            sort_keys=True,
        )
    if output_format == "md":
        return render_markdown(report, top=top, show_prompts=show_prompts)
    return render_text(report, top=top, show_prompts=show_prompts)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report = analyze_coral_home(
        args.home.expanduser(),
        sessions_dir=args.sessions_dir.expanduser()
        if args.sessions_dir is not None
        else None,
    )
    print(
        render_report(
            report,
            output_format=args.format,
            top=max(args.top, 0),
            show_prompts=args.show_prompts,
        )
    )
    return 1 if args.strict and report.issues else 0


if __name__ == "__main__":
    raise SystemExit(main())
