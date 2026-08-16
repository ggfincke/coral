# CLI reference

The `coral` program has two entry points. `src/cli/main.tsx` dispatches on the first argument:

- `coral exec …` → headless (`src/cli/exec.ts`)
- anything else → interactive TUI (`src/cli/interactive.tsx`)

`coral --help` does **not** list `exec`. Use `coral exec --help`.

Version comes from `package.json` (currently `0.14.0`) via `-V` / `--version` on the interactive command only. `coral exec` has no `--version`.

---

## Interactive: `coral`

```bash
coral [options]
npm run dev -- [options]
npm start -- [options]
```

| Flag                    | Help text in commander                                                             | Behavior                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `-V`, `--version`       | output the version number                                                          | Print version and exit                                                                                                                       |
| `-m`, `--model <model>` | Ollama model to use                                                                | Skip the picker; construct the Agent with this tag. Combined with `--resume` / `--session`, the **CLI model** is used with restored messages |
| `--host <url>`          | Ollama host URL                                                                    | Default `http://localhost:11434`. Must be `http` or `https`, no userinfo, query, or fragment                                                 |
| `--no-think`            | disable streamed reasoning requests                                                | Agent `think: false`. Default is think **on**                                                                                                |
| `--yolo`                | auto-approve gated calls; denies stay blocked; use exact pre-trusted MCP yoloTools | Start in yolo permission mode                                                                                                                |
| `--resume`              | resume the most recent session                                                     | Newest session by `updatedAt`. If that session's `cwd` no longer exists, Coral **exits 1** — it does not walk to the next session            |
| `--session <id>`        | resume a specific session by ID                                                    | **Exact** 8-hex id (no prefix). Same cwd check. Wins over `--resume`                                                                         |
| `--sessions`            | list saved sessions & exit                                                         | Prints every discovered session, newest first                                                                                                |
| `--theme <name>`        | color theme (see /theme for the list)                                              | Theme **id** or **label**, case-insensitive. Unknown name → exit 1 with the id list. Precedence: this flag > `prefs.json` > `coral-reef`     |
| `-h`, `--help`          | display help for command                                                           | Interactive help only                                                                                                                        |

Program name/description: `coral` / `A local-first CLI/TUI coding agent for Ollama`.

`--sessions` with none: `No saved sessions.` Footer: `Resume with: coral --session <id>`.

CLI resume errors (exit 1): `No sessions to resume.`; `Session not found: …` plus `Run coral --sessions to see available sessions.`; `Cannot resume session {id}.` / `Working directory no longer exists: {cwd}`; `Ambiguous session ID "…" — multiple matches:` plus `Use the full session ID.`; `Session already active: …` (TUI concern; CLI resume has no current session).

Invalid `--host` prints `Cannot start Coral: …` (same canonicalize errors as [Troubleshooting](troubleshooting.md)).

Unknown `--theme`: `Unknown theme: …` plus `Available themes: coral-reef, deep-sea, sunset-tide, kelp-forest, tide-pool, adaptive`. Unknown saved prefs theme is ignored with a stderr warning.

---

## Headless: `coral exec`

Runs **one** noninteractive Agent turn. It does **not** create or update a Coral session, prompt history, or interactive telemetry.

```bash
coral exec \
  --model gemma4:31b-mlx \
  --cwd /path/to/worktree \
  --permission-profile read-only \
  --output-format stream-json \
  --result-file /path/to/result.json \
  --prompt-file /path/to/prompt.md \
  --ephemeral \
  --no-mcp
```

| Flag / argument                  | Help text                                    | Default                       | Notes                                                            |
| -------------------------------- | -------------------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `[prompt]`                       | prompt text; quote multiword prompts         | —                             | Mutually exclusive with `--prompt-file`                          |
| `-m, --model <model>`            | Ollama model to use                          | **required**                  | Empty after trim → `model must be nonempty`                      |
| `--prompt-file <path>`           | read the prompt from a UTF-8 file            | —                             | Max **1,048,576** bytes                                          |
| `--cwd <path>`                   | workspace directory                          | `process.cwd()` at parse time | Must be a directory                                              |
| `--host <url>`                   | Ollama host URL                              | `http://localhost:11434`      | Same canonicalize rules                                          |
| `--permission-profile <profile>` | headless tool profile                        | `read-only`                   | Choices: `read-only`, `workspace-write`                          |
| `--output-format <format>`       | stdout format                                | `text`                        | Choices: `text`, `json`, `stream-json`                           |
| `--result-file <path>`           | atomically write the structured result       | —                             | Same JSON as the final result object                             |
| `--ephemeral`                    | do not persist a Coral conversation          | —                             | **Accepted and unused.** Exec never persists sessions either way |
| `--mcp`                          | enable pre-trusted, always-allowed MCP tools | `false`                       | `mcpMode: 'ask'` but every approval is rejected                  |
| `--no-mcp`                       | explicitly disable configured MCP servers    | —                             | Sets MCP off                                                     |
| `-h, --help`                     | display help for command                     | —                             |                                                                  |

Prompt errors: `provide either a prompt argument or --prompt-file, not both`; `a nonempty prompt is required`; `prompt file exceeds 1048576 bytes`; `not a directory: …`.

### Exit codes

| Status                                            | Code                   |
| ------------------------------------------------- | ---------------------- |
| completed                                         | 0                      |
| failed (Agent error or result-file write failure) | 1                      |
| cancelled SIGINT                                  | 130                    |
| cancelled SIGTERM                                 | 143                    |
| Commander parse/help/version-style errors         | commander's `exitCode` |
| other thrown errors                               | 2                      |

### Permission profiles

Every listed tool is set to `always_allow` inside the profile. Approvals still **always return false**, so anything that still requires a prompt (including MCP launch, doom-loop continue, and tools not in the profile) is rejected.

**`read-only`** (same set as read-only subagents):

`read_file`, `grep`, `glob`, `list_files`, `search_code`, `code_intel`, `git_status`, `git_diff`, `git_log`

**`workspace-write`:** those plus `write_file`, `edit_file`, `bash`.

**In neither profile:** `git_add`, `git_commit`, `git_switch`, `git_push`, `task`, `todo_write`.

`--mcp` copies `mcp__*` keys from `resolvePermissions(cwd)` into the map. Only tools that are already launch-trusted **and** `always_allow` can run; launch prompts and `require_approval` MCP calls are rejected. `verifyEdits` is always `false` (project `verify.enabled` is ignored). Think is left at the Agent default (`true`); there is no `--no-think` on exec.

These profiles are catalogs, not a sandbox. `bash` still runs on the host.

### Output

**`text`:** final assistant response plus a newline if nonempty.

**`json`:** one `CoralExecResult` object.

**`stream-json`:** NDJSON events, then `{ "type": "result", …result }`.

Event `type` strings: `init`, `assistant_delta`, `thinking_delta`, `tool_call`, `tool_result`, `approval_rejected`, `mcp_launch_rejected`, `doom_loop_stopped`, `usage`, `done`, `error`, `result`.

Result object:

- `version`: `1`
- `run_id`: UUID
- `status`: `completed` \| `failed` \| `cancelled`
- `model`, `response`
- `usage`: `prompt_tokens`, `completion_tokens`, `prompt_eval_duration_ns`, `eval_duration_ns`
- optional `error`

Result-file write failures set `error` to `failed to write result file: …`, or append it after `; ` if an Agent error already exists, and force `status: failed`. Errors are also written to stderr.

`stream-json` `usage` events carry Agent `TokenUsage` (**camelCase**: `promptTokens`, `completionTokens`, `promptEvalDurationNs`, `evalDurationNs`, …). The final result object's `usage` field is **snake_case** as listed above.

---

## Related

[Getting started](getting-started.md) · [TUI](tui.md) · [Permissions](permissions.md) · [Sessions](sessions.md) · [Configuration](configuration.md) · [Architecture](architecture.md)
