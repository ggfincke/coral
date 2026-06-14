# scripts/lib/coral_dev_tools/session_analysis.py
# parse Coral session stores & build aggregate reports

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
import hashlib
import json

from .report_render import render_counter, render_counter_md


JsonObject = dict[str, Any]

# ! keep in sync w/ src/agent/compaction.ts CHARS_PER_TOKEN
CHARS_PER_TOKEN = 4
# ! keep in sync w/ src/session/store.ts SESSION_INDEX_VERSION
SESSION_INDEX_VERSION = 1
RISKY_TOOLS = {"bash", "write_file", "edit_file"}


@dataclass(frozen=True)
class Issue:
    severity: str
    message: str

    def to_json(self) -> JsonObject:
        return {"severity": self.severity, "message": self.message}


@dataclass(frozen=True)
class LoadedSession:
    path: Path
    meta: JsonObject
    messages: list[JsonObject]

    @property
    def session_id(self) -> str:
        value = self.meta.get("id")
        return value if isinstance(value, str) else self.path.stem


@dataclass(frozen=True)
class SessionMetrics:
    session_id: str
    title: str
    model: str
    cwd: str
    path: str
    updated_at: str
    message_count: int
    meta_message_count: int | None
    user_messages: int
    assistant_messages: int
    tool_messages: int
    tool_calls: int
    risky_tool_calls: int
    unmatched_tool_delta: int
    compaction_count: int
    estimated_tokens: int
    largest_tool_output_chars: int
    largest_tool_output_name: str

    def to_json(self) -> JsonObject:
        return {
            "sessionId": self.session_id,
            "title": self.title,
            "model": self.model,
            "cwd": self.cwd,
            "path": self.path,
            "updatedAt": self.updated_at,
            "messageCount": self.message_count,
            "metaMessageCount": self.meta_message_count,
            "userMessages": self.user_messages,
            "assistantMessages": self.assistant_messages,
            "toolMessages": self.tool_messages,
            "toolCalls": self.tool_calls,
            "riskyToolCalls": self.risky_tool_calls,
            "unmatchedToolDelta": self.unmatched_tool_delta,
            "compactionCount": self.compaction_count,
            "estimatedTokens": self.estimated_tokens,
            "largestToolOutputChars": self.largest_tool_output_chars,
            "largestToolOutputName": self.largest_tool_output_name,
        }


@dataclass(frozen=True)
class HistorySummary:
    path: str
    entry_count: int
    corrupt_lines: int
    session_linked_entries: int
    repeated_prompts: list[tuple[str, int]]

    def to_json(self) -> JsonObject:
        return {
            "path": self.path,
            "entryCount": self.entry_count,
            "corruptLines": self.corrupt_lines,
            "sessionLinkedEntries": self.session_linked_entries,
            "repeatedPrompts": [
                {"text": text, "count": count}
                for text, count in self.repeated_prompts
            ],
        }


@dataclass(frozen=True)
class AnalysisReport:
    home: Path
    sessions_dir: Path
    index_path: Path
    index_count: int
    session_count: int
    history: HistorySummary
    sessions: list[SessionMetrics]
    models: Counter[str] = field(default_factory=Counter)
    cwd_counts: Counter[str] = field(default_factory=Counter)
    tool_counts: Counter[str] = field(default_factory=Counter)
    role_counts: Counter[str] = field(default_factory=Counter)
    issues: list[Issue] = field(default_factory=list)

    def to_json(self) -> JsonObject:
        return {
            "home": str(self.home),
            "sessionsDir": str(self.sessions_dir),
            "indexPath": str(self.index_path),
            "indexCount": self.index_count,
            "sessionCount": self.session_count,
            "history": self.history.to_json(),
            "sessions": [session.to_json() for session in self.sessions],
            "models": dict(self.models),
            "cwdCounts": dict(self.cwd_counts),
            "toolCounts": dict(self.tool_counts),
            "roleCounts": dict(self.role_counts),
            "issues": [issue.to_json() for issue in self.issues],
        }


def read_json(path: Path) -> tuple[Any | None, str | None]:
    try:
        with path.open("r", encoding="utf-8") as file:
            return json.load(file), None
    except OSError as err:
        return None, f"could not read {path}: {err}"
    except json.JSONDecodeError as err:
        return None, f"invalid JSON in {path}: {err}"


def load_index(index_path: Path) -> tuple[list[JsonObject], list[Issue]]:
    if not index_path.exists():
        return [], []

    raw, error = read_json(index_path)
    if error:
        return [], [Issue("error", error)]
    if not isinstance(raw, dict):
        return [], [Issue("error", f"{index_path} is not a JSON object")]

    version = raw.get("version")
    if version != SESSION_INDEX_VERSION:
        return [], [
            Issue(
                "warning",
                f"{index_path} version is {version}, expected {SESSION_INDEX_VERSION}",
            )
        ]

    sessions = raw.get("sessions")
    if not isinstance(sessions, list):
        return [], [Issue("error", f"{index_path} sessions field is not a list")]

    valid = [item for item in sessions if isinstance(item, dict)]
    invalid = len(sessions) - len(valid)
    issues = []
    if invalid:
        issues.append(
            Issue("warning", f"{index_path} contains {invalid} invalid index rows")
        )
    return valid, issues


def load_sessions(sessions_dir: Path) -> tuple[list[LoadedSession], list[Issue]]:
    if not sessions_dir.exists():
        return [], []

    sessions: list[LoadedSession] = []
    issues: list[Issue] = []
    for path in sorted(sessions_dir.glob("*.json")):
        if path.name == "index.json":
            continue

        raw, error = read_json(path)
        if error:
            issues.append(Issue("error", error))
            continue
        if not isinstance(raw, dict):
            issues.append(Issue("error", f"{path} is not a JSON object"))
            continue

        meta = raw.get("meta")
        messages = raw.get("messages")
        if not isinstance(meta, dict) or not isinstance(messages, list):
            issues.append(Issue("error", f"{path} is missing meta/messages"))
            continue

        valid_messages = [msg for msg in messages if isinstance(msg, dict)]
        invalid_messages = len(messages) - len(valid_messages)
        if invalid_messages:
            issues.append(
                Issue(
                    "warning",
                    f"{path} has {invalid_messages} non-object message rows",
                )
            )

        sessions.append(LoadedSession(path, meta, valid_messages))

    return sessions, issues


def estimate_message_tokens(message: JsonObject) -> int:
    chars = len(str(message.get("content", "")))
    thinking = message.get("thinking")
    if isinstance(thinking, str):
        chars += len(thinking)

    tool_name = message.get("tool_name")
    if isinstance(tool_name, str):
        chars += len(tool_name)

    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list):
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            func = call.get("function")
            if not isinstance(func, dict):
                continue
            chars += len(str(func.get("name", "")))
            chars += len(json.dumps(func.get("arguments", {}), sort_keys=True))

    return (chars + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN


def count_conversation_messages(messages: list[JsonObject]) -> int:
    return sum(1 for message in messages if message.get("role") != "system")


def tool_call_names(message: JsonObject) -> list[str]:
    calls = message.get("tool_calls")
    if not isinstance(calls, list):
        return []

    names: list[str] = []
    for call in calls:
        if not isinstance(call, dict):
            continue
        func = call.get("function")
        if not isinstance(func, dict):
            continue
        name = func.get("name")
        if isinstance(name, str) and name:
            names.append(name)
    return names


def session_title(meta: JsonObject) -> str:
    value = meta.get("title")
    if isinstance(value, str) and value:
        return value
    return "(untitled)"


def optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def metrics_for_session(
    session: LoadedSession,
    tool_counts: Counter[str],
    role_counts: Counter[str],
) -> tuple[SessionMetrics, list[Issue]]:
    meta = session.meta
    messages = session.messages
    session_id = session.session_id
    issues: list[Issue] = []

    if meta.get("id") != session.path.stem:
        issues.append(
            Issue(
                "warning",
                f"{session.path} filename does not match meta.id {meta.get('id')!r}",
            )
        )

    role_counter = Counter(
        role for message in messages if isinstance(role := message.get("role"), str)
    )
    role_counts.update(role_counter)

    tool_calls = 0
    risky_tool_calls = 0
    largest_tool_output_chars = 0
    largest_tool_output_name = ""
    estimated_tokens = 0

    for message in messages:
        estimated_tokens += estimate_message_tokens(message)
        names = tool_call_names(message)
        tool_calls += len(names)
        tool_counts.update(names)
        risky_tool_calls += sum(1 for name in names if name in RISKY_TOOLS)

        if message.get("role") == "tool":
            name = message.get("tool_name")
            tool_name = name if isinstance(name, str) and name else "(missing)"
            content_chars = len(str(message.get("content", "")))
            if content_chars > largest_tool_output_chars:
                largest_tool_output_chars = content_chars
                largest_tool_output_name = tool_name

    meta_message_count = optional_int(meta.get("messageCount"))
    actual_message_count = count_conversation_messages(messages)
    if (
        meta_message_count is not None
        and meta_message_count != actual_message_count
    ):
        issues.append(
            Issue(
                "warning",
                f"{session_id} meta.messageCount={meta_message_count} "
                f"but messages contain {actual_message_count}",
            )
        )

    tool_messages = role_counter["tool"]
    unmatched_tool_delta = tool_calls - tool_messages
    if tool_calls == 0 and tool_messages > 0:
        issues.append(
            Issue(
                "info",
                f"{session_id} has tool results but no recorded tool calls "
                "(likely legacy session format)",
            )
        )
    elif unmatched_tool_delta != 0:
        issues.append(
            Issue(
                "warning",
                f"{session_id} has {tool_calls} tool calls but {tool_messages} "
                "tool result messages",
            )
        )

    compaction_count = optional_int(meta.get("compactionCount")) or 0
    metrics = SessionMetrics(
        session_id=session_id,
        title=session_title(meta),
        model=str(meta.get("model", "(unknown)")),
        cwd=str(meta.get("cwd", "(unknown)")),
        path=str(session.path),
        updated_at=str(meta.get("updatedAt", "")),
        message_count=actual_message_count,
        meta_message_count=meta_message_count,
        user_messages=role_counter["user"],
        assistant_messages=role_counter["assistant"],
        tool_messages=tool_messages,
        tool_calls=tool_calls,
        risky_tool_calls=risky_tool_calls,
        unmatched_tool_delta=unmatched_tool_delta,
        compaction_count=compaction_count,
        estimated_tokens=estimated_tokens,
        largest_tool_output_chars=largest_tool_output_chars,
        largest_tool_output_name=largest_tool_output_name,
    )
    return metrics, issues


def normalize_prompt(text: str) -> str:
    return " ".join(text.split())


def analyze_history(path: Path) -> HistorySummary:
    if not path.exists():
        return HistorySummary(str(path), 0, 0, 0, [])

    entry_count = 0
    corrupt_lines = 0
    session_linked_entries = 0
    prompts: Counter[str] = Counter()

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return HistorySummary(str(path), 0, 1, 0, [])

    for line in lines:
        if not line.strip():
            continue

        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            corrupt_lines += 1
            continue

        if not isinstance(raw, dict) or not isinstance(raw.get("text"), str):
            corrupt_lines += 1
            continue

        entry_count += 1
        text = normalize_prompt(raw["text"])
        if text:
            prompts[text] += 1
        if isinstance(raw.get("sessionId"), str):
            session_linked_entries += 1

    repeated_prompts = [
        (text, count) for text, count in prompts.most_common() if count > 1
    ]
    return HistorySummary(
        path=str(path),
        entry_count=entry_count,
        corrupt_lines=corrupt_lines,
        session_linked_entries=session_linked_entries,
        repeated_prompts=repeated_prompts,
    )


def compare_index_to_files(
    index_rows: list[JsonObject],
    sessions: list[LoadedSession],
) -> list[Issue]:
    issues: list[Issue] = []
    file_ids = {session.session_id for session in sessions}
    index_ids = {
        value
        for row in index_rows
        if isinstance(value := row.get("id"), str) and value
    }

    for missing in sorted(index_ids - file_ids):
        issues.append(Issue("warning", f"index contains {missing} with no file"))
    for missing in sorted(file_ids - index_ids):
        issues.append(Issue("warning", f"session file {missing} is missing from index"))

    return issues


def analyze_coral_home(
    home: Path,
    *,
    sessions_dir: Path | None = None,
) -> AnalysisReport:
    home = home.expanduser().resolve()
    sessions_dir = (sessions_dir or home / "sessions").expanduser().resolve()
    index_path = sessions_dir / "index.json"

    index_rows, index_issues = load_index(index_path)
    sessions, session_issues = load_sessions(sessions_dir)
    history = analyze_history(home / "history.jsonl")

    models: Counter[str] = Counter()
    cwd_counts: Counter[str] = Counter()
    tool_counts: Counter[str] = Counter()
    role_counts: Counter[str] = Counter()
    metrics: list[SessionMetrics] = []
    issues: list[Issue] = []
    issues.extend(index_issues)
    issues.extend(session_issues)
    issues.extend(compare_index_to_files(index_rows, sessions))

    if history.corrupt_lines:
        issues.append(
            Issue(
                "warning",
                f"{history.path} contains {history.corrupt_lines} corrupt lines",
            )
        )

    for session in sessions:
        session_metrics, session_metric_issues = metrics_for_session(
            session,
            tool_counts,
            role_counts,
        )
        metrics.append(session_metrics)
        issues.extend(session_metric_issues)
        models.update([session_metrics.model])
        cwd_counts.update([session_metrics.cwd])

    metrics.sort(key=lambda item: item.updated_at, reverse=True)

    return AnalysisReport(
        home=home,
        sessions_dir=sessions_dir,
        index_path=index_path,
        index_count=len(index_rows),
        session_count=len(sessions),
        history=history,
        sessions=metrics,
        models=models,
        cwd_counts=cwd_counts,
        tool_counts=tool_counts,
        role_counts=role_counts,
        issues=issues,
    )


def plural(count: int, noun: str) -> str:
    suffix = "" if count == 1 else "s"
    return f"{count} {noun}{suffix}"


def render_sessions(sessions: list[SessionMetrics], limit: int) -> list[str]:
    lines = ["Recent sessions"]
    if not sessions:
        lines.append("  (none)")
        return lines
    for session in sessions[:limit]:
        title = session.title.replace("\n", " ")
        lines.append(
            f"  {session.session_id}  {session.model}  "
            f"{plural(session.message_count, 'message')}  {title}"
        )
    return lines


def render_largest_outputs(
    sessions: list[SessionMetrics],
    limit: int,
) -> list[str]:
    lines = ["Largest tool outputs"]
    largest = [
        session for session in sessions if session.largest_tool_output_chars > 0
    ]
    largest.sort(key=lambda item: item.largest_tool_output_chars, reverse=True)
    if not largest:
        lines.append("  (none)")
        return lines
    for session in largest[:limit]:
        lines.append(
            f"  {session.session_id}  {session.largest_tool_output_name}: "
            f"{session.largest_tool_output_chars} chars"
        )
    return lines


def render_repeated_prompts(
    history: HistorySummary,
    *,
    limit: int,
    show_prompts: bool,
) -> list[str]:
    lines = ["Repeated prompts"]
    if not history.repeated_prompts:
        lines.append("  (none)")
        return lines

    for text, count in history.repeated_prompts[:limit]:
        if show_prompts:
            preview = text if len(text) <= 120 else text[:117] + "..."
            lines.append(f"  {count}x  {preview}")
        else:
            digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:10]
            lines.append(
                f"  {count}x  prompt:{digest} ({len(text)} chars; "
                "pass --show-prompts)"
            )
    return lines


def render_issues(issues: list[Issue], limit: int) -> list[str]:
    lines = ["Integrity checks"]
    if not issues:
        lines.append("  OK")
        return lines
    for issue in issues[:limit]:
        lines.append(f"  [{issue.severity}] {issue.message}")
    if len(issues) > limit:
        lines.append(f"  ... {len(issues) - limit} more")
    return lines


def report_totals(report: AnalysisReport) -> tuple[int, int, int, int]:
    return (
        sum(session.message_count for session in report.sessions),
        sum(session.tool_calls for session in report.sessions),
        sum(session.compaction_count for session in report.sessions),
        sum(session.estimated_tokens for session in report.sessions),
    )


def render_text(
    report: AnalysisReport,
    *,
    top: int = 8,
    show_prompts: bool = False,
) -> str:
    (
        total_messages,
        total_tool_calls,
        total_compactions,
        total_estimated_tokens,
    ) = report_totals(report)

    lines = [
        "Coral session analysis",
        f"Home: {report.home}",
        f"Sessions dir: {report.sessions_dir}",
        "",
        "Summary",
        f"  Sessions loaded: {report.session_count}",
        f"  Index entries: {report.index_count}",
        f"  Messages: {total_messages}",
        f"  Tool calls: {total_tool_calls}",
        f"  Compactions: {total_compactions}",
        f"  Estimated live tokens scanned: {total_estimated_tokens}",
        f"  History entries: {report.history.entry_count}",
        f"  History corrupt lines: {report.history.corrupt_lines}",
        "",
        *render_counter("Models", report.models, top),
        "",
        *render_counter("Working directories", report.cwd_counts, top),
        "",
        *render_counter("Tools", report.tool_counts, top),
        "",
        *render_counter("Message roles", report.role_counts, top),
        "",
        *render_largest_outputs(report.sessions, top),
        "",
        *render_repeated_prompts(
            report.history,
            limit=top,
            show_prompts=show_prompts,
        ),
        "",
        *render_sessions(report.sessions, top),
        "",
        *render_issues(report.issues, max(top, 1)),
    ]
    return "\n".join(lines)


def markdown_table(rows: list[tuple[str, str]]) -> list[str]:
    lines = ["| Metric | Value |", "|---|---|"]
    lines.extend(f"| {name} | {value} |" for name, value in rows)
    return lines


def render_markdown(
    report: AnalysisReport,
    *,
    top: int = 8,
    show_prompts: bool = False,
) -> str:
    (
        total_messages,
        total_tool_calls,
        total_compactions,
        total_estimated_tokens,
    ) = report_totals(report)

    lines = [
        "# Coral Session Analysis",
        "",
        *markdown_table(
            [
                ("Home", f"`{report.home}`"),
                ("Sessions dir", f"`{report.sessions_dir}`"),
                ("Sessions loaded", str(report.session_count)),
                ("Index entries", str(report.index_count)),
                ("Messages", str(total_messages)),
                ("Tool calls", str(total_tool_calls)),
                ("Compactions", str(total_compactions)),
                ("Estimated live tokens scanned", str(total_estimated_tokens)),
                ("History entries", str(report.history.entry_count)),
                ("History corrupt lines", str(report.history.corrupt_lines)),
            ]
        ),
        "",
        *render_counter_md("Models", report.models, top),
        "",
        *render_counter_md("Working Directories", report.cwd_counts, top),
        "",
        *render_counter_md("Tools", report.tool_counts, top),
        "",
        *render_counter_md("Message Roles", report.role_counts, top),
        "",
        "## Largest Tool Outputs",
        "",
    ]

    largest = [
        session for session in report.sessions if session.largest_tool_output_chars
    ]
    largest.sort(key=lambda item: item.largest_tool_output_chars, reverse=True)
    if largest:
        lines.extend(["| Session | Tool | Chars |", "|---|---|---:|"])
        lines.extend(
            f"| `{session.session_id}` | `{session.largest_tool_output_name}` | "
            f"{session.largest_tool_output_chars} |"
            for session in largest[:top]
        )
    else:
        lines.append("_None._")

    lines.extend(["", "## Repeated Prompts", ""])
    if report.history.repeated_prompts:
        lines.extend(["| Count | Prompt |", "|---:|---|"])
        for text, count in report.history.repeated_prompts[:top]:
            if show_prompts:
                prompt = text
            else:
                digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:10]
                prompt = f"prompt:{digest} ({len(text)} chars; pass --show-prompts)"
            if len(prompt) > 160:
                prompt = prompt[:157] + "..."
            prompt = prompt.replace("|", "\\|")
            lines.append(f"| {count} | {prompt} |")
    else:
        lines.append("_None._")

    lines.extend(["", "## Recent Sessions", ""])
    if report.sessions:
        lines.extend(["| Session | Model | Messages | Title |", "|---|---|---:|---|"])
        for session in report.sessions[:top]:
            title = session.title.replace("|", "\\|").replace("\n", " ")
            lines.append(
                f"| `{session.session_id}` | `{session.model}` | "
                f"{session.message_count} | {title} |"
            )
    else:
        lines.append("_None._")

    lines.extend(["", "## Integrity Checks", ""])
    if report.issues:
        issue_limit = max(top, 1)
        lines.extend(["| Severity | Issue |", "|---|---|"])
        for issue in report.issues[:issue_limit]:
            message = issue.message.replace("|", "\\|")
            lines.append(f"| {issue.severity} | {message} |")
        if len(report.issues) > issue_limit:
            hidden = len(report.issues) - issue_limit
            lines.append(f"| info | {hidden} more issues hidden |")
    else:
        lines.append("_OK._")

    return "\n".join(lines)
