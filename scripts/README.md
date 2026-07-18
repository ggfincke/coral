# scripts

Repo maintenance and research tooling for Coral.

## Toolchain

Coral requires Node.js 24 or newer. Its build and typecheck scripts explicitly
run TypeScript 7. TypeScript 6 is a runtime dependency for the bundled
TypeScript language server and remains compatible with `typescript-eslint`.

## Dev tools

These scripts are dev-only and run through `uv` with Python 3.14 from
`.python-version`. Shared script code lives under `scripts/lib/`; it does not
participate in the shipped Node runtime.

```bash
npm run check:dev-tools
npm run check:architecture
npm run typecheck:scripts
npm run sessions:analyze
npm run reference:inventory
```

`check:dev-tools` compiles the Python dev-tool sources, runs focused dev-tool
regressions, and checks analyzer constants against runtime policy defaults.
`check:architecture` resolves local TypeScript imports and enforces Coral's
runtime-cycle, application-entry, subsystem-direction, lazy-MCP, and ambient-cwd
boundaries.
`typecheck:scripts` typechecks the TypeScript eval and benchmark entrypoints.

Direct invocations are also supported:

```bash
uv run python scripts/analyze-sessions.py --format md --top 12
uv run python scripts/analyze-sessions.py --show-prompts
uv run python scripts/mine-reference.py reference --format md
```

`analyze-sessions.py` is read-only. It scans `CORAL_HOME` or `~/.coral` for
authoritative eight-character session JSON files and `history.jsonl`, then
reports aggregate usage, tool-call counts, largest tool outputs, repeated
prompts, and session-file consistency checks. Legacy `sessions/index.json`
files are ignored because the runtime no longer treats them as authoritative.

`mine-reference.py` scans the git-excluded `reference/` tree for design-research
candidates: prompt/instruction files, tool-related files, permission/policy
files, slash-command candidates, and tool-name candidates. Treat its matches as
research leads, not proof.
