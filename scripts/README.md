# scripts

Repo maintenance and research tooling for Coral.

## Dev tools

These scripts are dev-only and run through `uv` with Python 3.14 from
`.python-version`. Shared script code lives under `scripts/lib/`; it does not
participate in the shipped Node runtime.

```bash
npm run check:dev-tools
npm run test:dev-tools
npm run sessions:analyze
npm run reference:inventory
```

Direct invocations are also supported:

```bash
uv run python scripts/analyze-sessions.py --format md --top 12
uv run python scripts/analyze-sessions.py --show-prompts
uv run python scripts/mine-reference.py reference --format md
```

`analyze-sessions.py` is read-only. It scans `CORAL_HOME` or `~/.coral` for
`sessions/index.json`, `sessions/*.json`, and `history.jsonl`, then reports
aggregate usage, tool-call counts, largest tool outputs, repeated prompts, and
session-store consistency checks.

`mine-reference.py` scans the git-excluded `reference/` tree for design-research
candidates: prompt/instruction files, tool-related files, permission/policy
files, slash-command candidates, and tool-name candidates. Treat its matches as
research leads, not proof.
