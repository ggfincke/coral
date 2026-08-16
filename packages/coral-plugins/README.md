# Coral Python plugin host

Unpublished local package (`packages/coral-plugins`). It is **not** a uv
workspace member of the repo-root `coral-dev-tools` project, and it is not
published to PyPI.

Write MCP tools in Python that Coral will admit through the **existing** MCP
host. No second plugin loader. No TypeScript MCP changes.

Install and run from this directory:

```bash
uv sync
uv run python -m coral_plugins examples.wordcount
```

That command speaks MCP on stdio and waits. A host must launch it. Running it
in a terminal looks hung; that is correct.

## Workspace path convention

**MCP cwd is always `$HOME`**, never the project (`launchCwd: homedir()` in
`src/config/mcp.ts`). Plugins that assume "cwd is the workspace" are wrong.
Coral does **not** inject workspace-path handling for dynamic tools.

Every example tool that reads project files takes an **explicit absolute
`path` argument**. Relative paths are rejected so they cannot silently read
from home.

## User config (`~/.coral.json` only)

Project `.coral.json` drops `mcp` even if present. Put this in **user**
`~/.coral.json`. Replace the `--project` path with the absolute path to this
directory. Raise `startupTimeoutMs` above Coral's 10s default: cold `uv run`
can miss `DEFAULT_MCP_STARTUP_TIMEOUT_MS = 10_000`. Allowed range 1s-60s.

After relocating a checkout, update that absolute path manually and
re-approve the server in interactive ask mode. The path is part of Coral's MCP
launch fingerprint; Coral does not rewrite `~/.coral.json` or trust sidecars.

```json
{
  "mcp": {
    "servers": {
      "pytools": {
        "command": "uv",
        "args": [
          "run",
          "--project",
          "/abs/path/to/packages/coral-plugins",
          "python",
          "-m",
          "coral_plugins",
          "examples.wordcount"
        ],
        "enabledTools": ["word_count"],
        "startupTimeoutMs": 30000
      }
    }
  }
}
```

Alias `/^[a-z0-9][a-z0-9_-]{0,31}$/`. `command` is a PATH name or **absolute**
path if it contains `/` or `\`.

Model-facing name: `mcp__pytools__word_count`. First interactive use in ask
mode prompts for launch trust. `coral exec --mcp` fail-closes that prompt, so
admission cannot be verified non-interactively.

## Authoring a tool

```python
from pydantic import BaseModel, Field
from coral_plugins.tool import tool

class WordCountArgs(BaseModel):
    path: str = Field(description="absolute workspace file path")

@tool(WordCountArgs, description="count words in one UTF-8 file")
def word_count(args: WordCountArgs) -> str:
    ...
```

`@tool` flattens the Pydantic v2 model to top-level MCP arguments and strips
verbose JSON Schema `title` / `$defs` so the payload stays inside Coral's
schema caps. Pass `description=` on the decorator (plain comments, not
function docstrings).

Load the module with `python -m coral_plugins your.module`. The host adds this
project root to `sys.path` so `examples.*` imports work even though MCP cwd is
`$HOME`.

## Caps (operate inside these; do not ask TypeScript to raise them)

| Cap                  | Value                                                                                                       | Where                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Servers              | 4                                                                                                           | `MAX_SERVERS` in `src/config/mcp.ts`                    |
| Enabled tools        | 12 **global** (sum of `enabledTools`; also the per-server parse max)                                        | `MAX_TOOLS`                                             |
| Args                 | <=64 x 4096 chars                                                                                           | `MAX_ARGS`, `MAX_ARG_CHARS`                             |
| `passEnv`            | <=32 names                                                                                                  | `MAX_ENV_NAMES`; missing var fails the server           |
| Startup timeout      | 1s-60s, default 10s                                                                                         | `DEFAULT_MCP_STARTUP_TIMEOUT_MS`                        |
| Tool timeout         | 1s-600s, default 60s                                                                                        | `DEFAULT_MCP_TOOL_TIMEOUT_MS`                           |
| Schema               | 25k chars/tool, 100k total                                                                                  | `src/mcp/manager.ts`                                    |
| Session token budget | `max(promptLimit x 0.5 - trusted, 0)`                                                                       | `Agent.dynamicToolTokenBudget`; oversized tools skipped |
| cwd                  | `$HOME`                                                                                                     | `launchCwd: homedir()`                                  |
| Calls                | fully serialized, one queue                                                                                 | `enqueueCall`                                           |
| Timeout/abort        | **stops that server** for the session                                                                       | `stopSession`                                           |
| Names                | `mcp__<alias>__<tool>`                                                                                      | `canonicalToolName`                                     |
| Output               | ANSI/control stripped, `passEnv` values redacted, 100k char cap; structured JSON 80k / depth 20 / 200 items | `src/mcp/output.ts`, `MAX_TOOL_OUTPUT_CHARS`            |

Env = MCP SDK `getDefaultEnvironment()` (typically HOME, PATH, SHELL, TERM,
USER, LOGNAME on Unix) **plus** `passEnv` only. `passEnv` values become
redaction secrets.

## Security posture (plugins must not)

- Self-grant policy. Annotations are **never read**. Default is
  `UNKNOWN_TOOL_DEFAULT_POLICY = 'require_approval'`
  (`src/tools/catalog.ts`). User `~/.coral.json` `permissions` may set
  `always_allow` per namespaced name. Project config can only **tighten**.
- Impersonate built-in names, workspace-path metadata, parallel execution, or
  subagent eligibility. Dynamic tools cannot.
- Write `CORAL_HOME` state files (sessions, telemetry, prefs, MCP trust,
  retrieval SQLite, history). Those stay TypeScript-owned.
- Depend on cwd being the workspace.
- Treat MCP as a sandbox. Bounds limit protocol messages, not process
  authority.

Trust = SHA-256 of alias, command, executable, args, `launchCwd`, sorted
`passEnv` names, sorted `enabledTools`, and sorted `yoloTools` **only if
nonempty**. Persisted `CORAL_HOME/mcp-trust.d/<alias>.json`. Any change
invalidates.

## File mutation: forbidden

Do **not** ship file-mutating tools. Only Coral `write_file` / `edit_file`
emit undo records (`{path, before, after}` snapshots). A Python tool that
writes files will desync `/undo`. A host-mediated patch pathway does not
exist yet; until it does, mutating tools are forbidden in this scaffold.

Computation, analysis, external-service, and **read-only** tools are the
intended surface.

## Tests

From this directory, after `uv sync`:

```bash
uv run python -m unittest discover -s tests -v
```

## Dependency maintenance

Each Python package owns its `pyproject.toml` and checked-in `uv.lock`; these
projects are not a root uv workspace. Dependabot opens separate weekly `uv`
pull requests for the backend, SDK, and plugin package. Do not auto-merge
those PRs. The accepted dependency is the newest version that passes its
locked package suite and the repository's aggregate Python gates, not a
permanent pin to the current lock.

For this package, keep normal updates inside `mcp~=2.0`. A major MCP update
must deliberately change that requirement and its lock in the same PR. Before
merging an update, run from the repository root:

```bash
uv run --project packages/coral-plugins --locked \
  python -m unittest discover -s packages/coral-plugins/tests -v
npm run test:python
```

The plugin gate must include both compact-schema assertions and the real stdio
listing/call test. A lock-only update that breaks the private MCP schema
compatibility boundary is not green.

## Manual Coral admission

Interactive Coral has to approve launch trust; this cannot be done from
`coral exec`. After the `~/.coral.json` snippet is in place:

1. `uv sync` in this directory (once).
2. Start interactive Coral (`npm run dev`) in **ask** mode.
3. Send a turn so MCP bootstraps. Approve the `pytools` launch-trust prompt.
4. `/mcp` should list alias `pytools` and enabled tool `word_count`.
5. Ask Coral to count words in a file, giving an **absolute** path. The
   model-facing tool name is `mcp__pytools__word_count`.
