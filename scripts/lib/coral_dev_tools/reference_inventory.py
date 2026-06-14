# scripts/lib/coral_dev_tools/reference_inventory.py
# scan git-excluded reference projects for useful design pointers

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable
import re

from .report_render import render_counter, render_counter_md


TEXT_SUFFIXES = {
    ".cjs",
    ".go",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".mjs",
    ".py",
    ".rs",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
SKIP_DIRS = {
    ".git",
    ".next",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
}
PROMPT_HINT = re.compile(r"(system[-_ ]?prompt|prompt|instruction)", re.I)
TOOL_HINT = re.compile(r"(\btool\b|tools|toolcall|tool_call)", re.I)
PERMISSION_HINT = re.compile(r"(permission|approval|sandbox|policy)", re.I)
SLASH_COMMAND = re.compile(r"(?<![.<:@\w/])/[a-z][a-z0-9_-]{1,32}(?![\w/-])")
TOOL_NAME = re.compile(r"\bname\s*[:=]\s*['\"]([a-zA-Z0-9_-]{2,64})['\"]")
COMMAND_CONTEXT = re.compile(r"(slash|command|commands|cmd|input|prompt|mention)", re.I)
PATH_LIKE_COMMANDS = {
    "/api",
    "/app",
    "/assets",
    "/auth",
    "/bin",
    "/components",
    "/css",
    "/definitions",
    "/dev",
    "/div",
    "/docs",
    "/etc",
    "/home",
    "/img",
    "/lib",
    "/login",
    "/node_modules",
    "/packages",
    "/src",
    "/tmp",
    "/usr",
    "/utils",
    "/var",
}
NOISY_TOOL_NAMES = {
    "alpha",
    "beta",
    "body",
    "data",
    "default",
    "error",
    "input",
    "result",
    "test",
    "title",
    "value",
}


@dataclass(frozen=True)
class FileHit:
    path: str
    score: int
    reasons: tuple[str, ...]

    def to_json(self) -> dict[str, object]:
        return {
            "path": self.path,
            "score": self.score,
            "reasons": list(self.reasons),
        }


@dataclass(frozen=True)
class ReferenceInventory:
    root: Path
    missing_root: bool
    file_count: int
    project_counts: Counter[str] = field(default_factory=Counter)
    extension_counts: Counter[str] = field(default_factory=Counter)
    slash_commands: Counter[str] = field(default_factory=Counter)
    tool_names: Counter[str] = field(default_factory=Counter)
    prompt_files: list[FileHit] = field(default_factory=list)
    tool_files: list[FileHit] = field(default_factory=list)
    permission_files: list[FileHit] = field(default_factory=list)

    def to_json(self) -> dict[str, object]:
        return {
            "root": str(self.root),
            "missingRoot": self.missing_root,
            "fileCount": self.file_count,
            "projectCounts": dict(self.project_counts),
            "extensionCounts": dict(self.extension_counts),
            "slashCommands": dict(self.slash_commands),
            "toolNames": dict(self.tool_names),
            "promptFiles": [hit.to_json() for hit in self.prompt_files],
            "toolFiles": [hit.to_json() for hit in self.tool_files],
            "permissionFiles": [
                hit.to_json() for hit in self.permission_files
            ],
        }


def should_skip(path: Path) -> bool:
    return any(part in SKIP_DIRS for part in path.parts)


def iter_text_files(root: Path) -> Iterable[Path]:
    for path in root.rglob("*"):
        if not path.is_file() or should_skip(path.relative_to(root)):
            continue
        if path.suffix.lower() in TEXT_SUFFIXES:
            yield path


def project_name(root: Path, path: Path) -> str:
    relative = path.relative_to(root)
    return relative.parts[0] if relative.parts else "."


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def command_candidates(path: Path, content: str) -> list[str]:
    path_has_context = COMMAND_CONTEXT.search(str(path)) is not None
    commands: list[str] = []
    for line in content.splitlines():
        stripped = line.strip()
        if not path_has_context and not COMMAND_CONTEXT.search(line):
            continue
        if stripped.startswith("import ") or stripped.startswith("export "):
            continue
        if "http://" in line or "https://" in line:
            continue
        if re.search(r"\b(GET|POST|PUT|PATCH|DELETE)\s+/", line):
            continue
        for command in SLASH_COMMAND.findall(line):
            if command in PATH_LIKE_COMMANDS:
                continue
            commands.append(command)
    return commands


def tool_name_candidates(content: str) -> list[str]:
    names: list[str] = []
    for name in TOOL_NAME.findall(content):
        lowered = name.lower()
        if lowered in NOISY_TOOL_NAMES:
            continue
        if lowered != name:
            continue
        if "_" not in name:
            continue
        names.append(name)
    return names


def make_hit(root: Path, path: Path, content: str, reasons: list[str]) -> FileHit:
    score = len(reasons) + min(content.count("\n"), 200) // 50
    return FileHit(str(path.relative_to(root)), score, tuple(reasons))


def collect_hits(
    root: Path,
    path: Path,
    content: str,
) -> tuple[FileHit | None, FileHit | None, FileHit | None]:
    lower_path = str(path).lower()

    prompt_reasons: list[str] = []
    if PROMPT_HINT.search(lower_path):
        prompt_reasons.append("path")
    if PROMPT_HINT.search(content):
        prompt_reasons.append("content")
    if "You are " in content or "system prompt" in content.lower():
        prompt_reasons.append("system-language")

    tool_reasons: list[str] = []
    if TOOL_HINT.search(lower_path):
        tool_reasons.append("path")
    if TOOL_HINT.search(content):
        tool_reasons.append("content")
    if "tool_calls" in content or "function_call" in content:
        tool_reasons.append("tool-call-shape")

    permission_reasons: list[str] = []
    if PERMISSION_HINT.search(lower_path):
        permission_reasons.append("path")
    if PERMISSION_HINT.search(content):
        permission_reasons.append("content")

    return (
        make_hit(root, path, content, prompt_reasons) if prompt_reasons else None,
        make_hit(root, path, content, tool_reasons) if tool_reasons else None,
        make_hit(root, path, content, permission_reasons)
        if permission_reasons
        else None,
    )


def inventory_reference_tree(root: Path, *, top: int = 12) -> ReferenceInventory:
    root = root.resolve()
    if not root.exists():
        return ReferenceInventory(root=root, missing_root=True, file_count=0)

    project_counts: Counter[str] = Counter()
    extension_counts: Counter[str] = Counter()
    slash_commands: Counter[str] = Counter()
    tool_names: Counter[str] = Counter()
    prompt_files: list[FileHit] = []
    tool_files: list[FileHit] = []
    permission_files: list[FileHit] = []
    file_count = 0

    for path in iter_text_files(root):
        file_count += 1
        project_counts.update([project_name(root, path)])
        extension_counts.update([path.suffix.lower() or "(none)"])
        content = read_text(path)
        slash_commands.update(command_candidates(path, content))
        tool_names.update(tool_name_candidates(content))

        prompt_hit, tool_hit, permission_hit = collect_hits(root, path, content)
        if prompt_hit:
            prompt_files.append(prompt_hit)
        if tool_hit:
            tool_files.append(tool_hit)
        if permission_hit:
            permission_files.append(permission_hit)

    by_score = lambda hit: (hit.score, hit.path)
    prompt_files.sort(key=by_score, reverse=True)
    tool_files.sort(key=by_score, reverse=True)
    permission_files.sort(key=by_score, reverse=True)

    return ReferenceInventory(
        root=root,
        missing_root=False,
        file_count=file_count,
        project_counts=project_counts,
        extension_counts=extension_counts,
        slash_commands=Counter(dict(slash_commands.most_common(top))),
        tool_names=Counter(dict(tool_names.most_common(top))),
        prompt_files=prompt_files[:top],
        tool_files=tool_files[:top],
        permission_files=permission_files[:top],
    )


def render_hits(title: str, hits: list[FileHit]) -> list[str]:
    lines = [title]
    if not hits:
        lines.append("  (none)")
        return lines
    for hit in hits:
        reasons = ", ".join(hit.reasons)
        lines.append(f"  {hit.path}  score={hit.score}  {reasons}")
    return lines


def render_text(report: ReferenceInventory) -> str:
    if report.missing_root:
        return f"Reference root not found: {report.root}"

    lines = [
        "Coral reference inventory",
        f"Root: {report.root}",
        f"Files scanned: {report.file_count}",
        "",
        *render_counter("Projects", report.project_counts),
        "",
        *render_counter("Extensions", report.extension_counts),
        "",
        *render_counter("Slash commands", report.slash_commands),
        "",
        *render_counter("Candidate tool names", report.tool_names),
        "",
        *render_hits("Prompt/instruction files", report.prompt_files),
        "",
        *render_hits("Tool-related files", report.tool_files),
        "",
        *render_hits("Permission/policy files", report.permission_files),
    ]
    return "\n".join(lines)


def render_hits_md(title: str, hits: list[FileHit]) -> list[str]:
    lines = [f"## {title}", ""]
    if not hits:
        return [*lines, "_None._"]
    lines.extend(["| Path | Score | Reasons |", "|---|---:|---|"])
    for hit in hits:
        reasons = ", ".join(hit.reasons)
        path = hit.path.replace("|", "\\|")
        lines.append(f"| `{path}` | {hit.score} | {reasons} |")
    return lines


def render_markdown(report: ReferenceInventory) -> str:
    if report.missing_root:
        return f"# Coral Reference Inventory\n\nReference root not found: `{report.root}`"

    lines = [
        "# Coral Reference Inventory",
        "",
        f"- Root: `{report.root}`",
        f"- Files scanned: {report.file_count}",
        "",
        *render_counter_md("Projects", report.project_counts),
        "",
        *render_counter_md("Extensions", report.extension_counts),
        "",
        *render_counter_md("Slash Commands", report.slash_commands),
        "",
        *render_counter_md("Candidate Tool Names", report.tool_names),
        "",
        *render_hits_md("Prompt/Instruction Files", report.prompt_files),
        "",
        *render_hits_md("Tool-Related Files", report.tool_files),
        "",
        *render_hits_md("Permission/Policy Files", report.permission_files),
    ]
    return "\n".join(lines)
