# Python plane (optional)

Coral stays a TypeScript coding agent. Python is optional compute and
extension: a local MLX worker, an unpublished SDK over `coral exec`, and MCP
tools you write yourself. None of this is on npm or PyPI. Coral runs
Python-free until you select an `mlx:` model, set an `mlx:` embedding model, or
configure a Python MCP server.

Package READMEs are the detailed how-tos. This page is the map.

If an existing `~/.coral.json` MCP server uses an absolute `--project` path,
update it manually to `packages/coral-plugins` after moving the checkout. The
changed launch argument produces a new MCP trust fingerprint, so re-approve
the server once in interactive ask mode; Coral does not rewrite user config or
trust sidecars. Likewise, update `inference.python` or `CORAL_PYTHON` only if
it points into a moved package `.venv`, then sync the target package.

## MLX chat (`packages/coral-backend`)

Select a checkpoint with `mlx:<name>` (`coral -m mlx:<name>`, the startup
picker, or `/model`). Bare names still mean Ollama. `--host` is the Ollama URL
and does not address the worker.

From the Coral checkout:

```bash
uv sync --project packages/coral-backend
```

Put weights in `CORAL_MLX_MODELS_DIR` (default `~/.coral/mlx-models`) as
`<name>/config.json` plus weight files. User `~/.coral.json` may set
`inference.python` and `inference.mlxModelsDir`; `CORAL_PYTHON` and
`CORAL_MLX_MODELS_DIR` win. Needs standard CPython 3.14 on macOS arm64 (not
`3.14t`).

Missing worker prints install/sync instructions, not a stack trace. Live smoke
steps: [packages/coral-backend/README.md](../packages/coral-backend/README.md).

## Python SDK (`packages/coral-sdk`)

Unpublished async `CoralClient` (plus a thin sync wrapper) that spawns
`coral exec --output-format stream-json` for **one** headless turn. It does not
resume sessions or prompt for approvals.

```bash
cd packages/coral-sdk
uv sync
```

Usage, binary discovery (`CORAL_BIN`), and the camelCase/snake_case usage split:
[packages/coral-sdk/README.md](../packages/coral-sdk/README.md). Exec events:
[CLI](cli.md).

## Python MCP tools (`packages/coral-plugins`)

Write tools with `@tool` and admit them through the existing MCP host. MCP cwd
is always `$HOME`; example tools take an explicit absolute `path`. No
file-mutating examples — undo only records `write_file` / `edit_file`.

Config lives in **user** `~/.coral.json` only. Snippet, caps, and cold-start
`startupTimeoutMs: 30000`:
[packages/coral-plugins/README.md](../packages/coral-plugins/README.md) and
[MCP](mcp.md).

## Protocol

JSON Schemas under `protocol/` are the source of truth for exec JSONL and the
worker envelope. `npm run protocol:gen` / `npm run protocol:check`.
[protocol/README.md](../protocol/README.md).
