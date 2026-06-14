# scripts/lib/coral_dev_tools/report_render.py
# shared Counter -> text/markdown rendering for the dev report scripts

from __future__ import annotations

from collections import Counter


def render_counter(
    title: str, counter: Counter[str], limit: int | None = None
) -> list[str]:
    lines = [title]
    if not counter:
        lines.append("  (none)")
        return lines
    for name, count in counter.most_common(limit):
        lines.append(f"  {name}: {count}")
    return lines


def render_counter_md(
    title: str, counter: Counter[str], limit: int | None = None
) -> list[str]:
    lines = [f"## {title}", ""]
    if not counter:
        return [*lines, "_None._"]
    lines.extend(["| Name | Count |", "|---|---:|"])
    lines.extend(
        f"| `{name}` | {count} |" for name, count in counter.most_common(limit)
    )
    return lines
