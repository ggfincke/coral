#!/usr/bin/env python3
# scripts/check-comment-style.py
# validate Python headers, class docs, comments, & tags

from __future__ import annotations

import argparse
import ast
import io
import re
import subprocess
import sys
import tokenize
from dataclasses import dataclass
from pathlib import Path

ROOT = Path.cwd()
PYTHON_ENCODING_RE = re.compile(r"coding[:=]\s*[-\w.]+")
TOOLING_COMMENT_RE = re.compile(
	r"^#\s*(?:noqa\b|type:\s*ignore\b|pragma:\s*no cover\b|pyright:|mypy:|ruff:|fmt:|isort:|coverage:)",
	re.IGNORECASE,
)
TODO_PREFIX_RE = re.compile(r"^#\s*todo\b", re.IGNORECASE)
VALID_TODO_RE = re.compile(r"^# TODO(?:\([a-z0-9][a-z0-9._/-]*\):)?\s+\S")
TAG_PREFIX_RE = re.compile(r"^#\s*([*!?])")
VALID_TAG_RE = re.compile(r"^# [*!?] \S")
LEGACY_TAG_RE = re.compile(r"^#\s*(?:FOOTGUN|HACK|NOTE|WARN(?:ING)?|FIXME|XXX):\s*", re.IGNORECASE)
PLAIN_COMMENT_RE = re.compile(r"^#\s+([A-Z][^\s]*)")
SKIP_PARTS = {".venv", "__pycache__", "migrations", "node_modules"}


# === violation model and source helpers ===
@dataclass(frozen=True)
class Violation:
	path: Path
	line: int
	message: str

	def render(self) -> str:
		return f"{self.path.relative_to(ROOT)}:{self.line}: {self.message}"


def resolve_root(explicit: Path | None) -> Path:
	if explicit is not None:
		return explicit.resolve()
	try:
		result = subprocess.run(
			["git", "rev-parse", "--show-toplevel"],
			capture_output=True,
			text=True,
			check=True,
		)
	except OSError, subprocess.CalledProcessError:
		return Path.cwd()
	return Path(result.stdout.strip() or ".").resolve()


def is_within(path: Path, parent: Path) -> bool:
	resolved = path.resolve()
	root = parent.resolve()
	return resolved == root or root in resolved.parents


def python_prelude_len(lines: list[str]) -> int:
	count = 1 if lines and lines[0].startswith("#!") else 0
	if count < len(lines):
		candidate = lines[count]
		if candidate.lstrip().startswith("#") and PYTHON_ENCODING_RE.search(candidate):
			count += 1
	return count


def is_test_path(path: Path) -> bool:
	relative = path.relative_to(ROOT)
	return "tests" in relative.parts or path.stem.startswith("test_")


def is_code_like_token(token: str) -> bool:
	return (
		token == "No."
		or any(char.isupper() for char in token[1:])
		or bool(re.search(r"[._\d]", token))
	)


def docstring_expr(node: ast.AST) -> ast.Expr | None:
	body = getattr(node, "body", None)
	if not body:
		return None
	first = body[0]
	if (
		isinstance(first, ast.Expr)
		and isinstance(first.value, ast.Constant)
		and isinstance(first.value.value, str)
	):
		return first
	return None


def docstring_violations(path: Path, tree: ast.Module) -> list[Violation]:
	violations: list[Violation] = []
	parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
	test_file = is_test_path(path)

	for node in ast.walk(tree):
		if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
			continue
		expr = docstring_expr(node)
		if expr is None:
			continue

		if (
			isinstance(node, ast.ClassDef)
			and isinstance(parents.get(node), ast.Module)
			and not node.name.startswith("_")
			and not test_file
		):
			continue

		if isinstance(node, ast.Module):
			message = "module docstrings are replaced by the two-line file header"
		elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
			message = "docstrings are for classes; use a plain comment above ordinary functions"
		else:
			message = "docstrings are allowed only on module-level classes"
		violations.append(Violation(path, expr.lineno, message))

	return violations


def header_violations(path: Path, lines: list[str]) -> list[Violation]:
	violations: list[Violation] = []
	header_index = python_prelude_len(lines)
	expected = f"# {path.relative_to(ROOT).as_posix()}"
	if len(lines) <= header_index or lines[header_index].rstrip("\r\n") != expected:
		violations.append(Violation(path, header_index + 1, f'file header must be "{expected}"'))
	if len(lines) <= header_index + 1:
		violations.append(
			Violation(path, header_index + 2, "file header needs a lowercase purpose phrase")
		)
		return violations

	description_line = lines[header_index + 1].rstrip("\r\n")
	if not description_line.startswith("# ") or not description_line[2:].strip():
		violations.append(
			Violation(path, header_index + 2, "file header needs a lowercase purpose phrase")
		)
		return violations
	description = description_line[2:].strip()
	if not re.match(r"^[a-z0-9]", description):
		violations.append(
			Violation(path, header_index + 2, "file header purpose must begin lowercase")
		)
	if description.endswith("."):
		violations.append(
			Violation(path, header_index + 2, "file header purpose must not end with a period")
		)
	if re.match(r"^(?:[*!?](?:\s|$)|todo(?:\([^)]*\))?:?\s)", description, re.IGNORECASE):
		violations.append(
			Violation(
				path,
				header_index + 2,
				"file header purpose must not use an annotation tag",
			)
		)
	if len(lines) > header_index + 2 and lines[header_index + 2].startswith("#"):
		violations.append(
			Violation(
				path,
				header_index + 3,
				"file headers must contain exactly two consecutive comment lines",
			)
		)
	return violations


def comment_violations(path: Path, text: str, header_lines: set[int]) -> list[Violation]:
	violations: list[Violation] = []
	try:
		tokens = tokenize.generate_tokens(io.StringIO(text).readline)
		comments = [token for token in tokens if token.type == tokenize.COMMENT]
	except tokenize.TokenError as exc:
		return [Violation(path, exc.args[1][0], "could not tokenize Python file")]

	for token in comments:
		comment = token.string
		prefix = token.line[: token.start[1]]
		if "→" in comment:
			violations.append(
				Violation(path, token.start[0], "use ASCII ->, not the Unicode arrow")
			)
		if comment.startswith("#!") or PYTHON_ENCODING_RE.search(comment):
			continue
		if prefix.strip() and not TOOLING_COMMENT_RE.match(comment):
			violations.append(
				Violation(
					path,
					token.start[0],
					"move prose comments above the code they describe",
				)
			)
		if token.start[0] in header_lines or TOOLING_COMMENT_RE.match(comment):
			continue
		if LEGACY_TAG_RE.match(comment):
			violations.append(
				Violation(
					path,
					token.start[0],
					"use a canonical `*`, `!`, `?`, or `TODO` annotation",
				)
			)
			continue
		if TODO_PREFIX_RE.match(comment) and not VALID_TODO_RE.match(comment):
			violations.append(
				Violation(
					path,
					token.start[0],
					"use `TODO action` or `TODO(scope): action` with an uppercase TODO and lowercase scope",
				)
			)
		elif TAG_PREFIX_RE.match(comment) and not VALID_TAG_RE.match(comment):
			violations.append(
				Violation(
					path,
					token.start[0],
					"use `# <tag> annotation` with one space around the tag",
				)
			)
		elif (match := PLAIN_COMMENT_RE.match(comment)) and not is_code_like_token(match.group(1)):
			violations.append(
				Violation(
					path,
					token.start[0],
					"plain comments start lowercase; preserve uppercase only for exact code symbols",
				)
			)
	return violations


# === file validation ===
def check_python_file(path: Path) -> list[Violation]:
	text = path.read_text()
	lines = text.splitlines(keepends=True)
	header_index = python_prelude_len(lines)
	violations = header_violations(path, lines)
	try:
		tree = ast.parse(text)
	except SyntaxError:
		return violations
	violations.extend(docstring_violations(path, tree))
	violations.extend(comment_violations(path, text, {header_index + 1, header_index + 2}))
	return violations


# === optional fixes and CLI discovery ===
def fix_python_file(path: Path) -> bool:
	text = path.read_text()
	lines = text.splitlines(keepends=True)
	header_index = python_prelude_len(lines)
	expected = f"# {path.relative_to(ROOT).as_posix()}"
	changed = False
	if (
		len(lines) > header_index + 1
		and lines[header_index].lstrip().startswith("# ")
		and lines[header_index + 1].lstrip().startswith("# ")
		and lines[header_index].rstrip("\r\n") != expected
	):
		ending = "\r\n" if lines[header_index].endswith("\r\n") else "\n"
		lines[header_index] = f"{expected}{ending}"
		changed = True

	text = "".join(lines)
	try:
		comments = [
			token
			for token in tokenize.generate_tokens(io.StringIO(text).readline)
			if token.type == tokenize.COMMENT
		]
	except tokenize.TokenError:
		comments = []
	for token in comments:
		replacement = token.string.replace("→", "->")
		match = PLAIN_COMMENT_RE.match(replacement)
		if (
			token.start[0] not in {header_index + 1, header_index + 2}
			and not TOOLING_COMMENT_RE.match(replacement)
			and not TODO_PREFIX_RE.match(replacement)
			and not TAG_PREFIX_RE.match(replacement)
			and match
			and not is_code_like_token(match.group(1))
		):
			marker = match.start(1)
			replacement = (
				f"{replacement[:marker]}{replacement[marker].lower()}{replacement[marker + 1 :]}"
			)
		if replacement == token.string:
			continue
		line_index = token.start[0] - 1
		line = lines[line_index]
		start = token.start[1]
		end = start + len(token.string)
		lines[line_index] = f"{line[:start]}{replacement}{line[end:]}"
		changed = True

	if changed:
		path.write_text("".join(lines))
	return changed


def python_paths(roots: tuple[Path, ...], supplied: list[Path]) -> list[Path]:
	if supplied:
		candidates = [path.resolve() for path in supplied if path.suffix == ".py" and path.exists()]
	else:
		candidates = [path for root in roots for path in root.rglob("*.py")]
	return sorted(
		{
			path
			for path in candidates
			if is_within(path, ROOT)
			and any(is_within(path, scan_root) for scan_root in roots)
			and not SKIP_PARTS.intersection(path.relative_to(ROOT).parts)
		}
	)


def parse_args() -> argparse.Namespace:
	parser = argparse.ArgumentParser(description="check Coral Python comment style")
	parser.add_argument("--check", action="store_true", help="check only")
	parser.add_argument("--root", type=Path, default=None, help="repository root")
	parser.add_argument("--python-root", action="append", type=Path, default=[])
	parser.add_argument("--fix", action="store_true", help="apply safe mechanical fixes")
	parser.add_argument("paths", nargs="*", type=Path, help="optional Python files to check")
	return parser.parse_args()


def main() -> int:
	args = parse_args()
	global ROOT
	ROOT = resolve_root(args.root)
	roots = tuple(path.resolve() for path in args.python_root) or (ROOT,)
	bad_roots = [root for root in roots if not is_within(root, ROOT)]
	bad_paths = [path for path in args.paths if path.exists() and not is_within(path, ROOT)]
	if bad_roots or bad_paths:
		for path in [*bad_roots, *bad_paths]:
			print(f"error: {path} is outside --root {ROOT}", file=sys.stderr)
		return 2

	paths = python_paths(roots, args.paths)
	if args.fix:
		for path in paths:
			fix_python_file(path)

	violations = [violation for path in paths for violation in check_python_file(path)]
	for violation in violations:
		print(violation.render())
	return 1 if violations else 0


if __name__ == "__main__":
	raise SystemExit(main())
