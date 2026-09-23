# CLI reference

`coral --help` lists interactive options and `exec`. Use `coral help exec` or `coral exec --help` for headless help. Help and version exit before loading Agent or Ink. Version comes from `package.json` and works on both entry paths.

## Interactive: `coral [options] [prompt]`

```bash
coral -C /path/to/project "Explain the failing build"
coral --resume
coral -C /path/to/project --resume
coral --session abc1
coral --sessions
```

An initial positional prompt is submitted exactly once after model/session startup completes. A newer composer draft stays intact. `-C` sets the agent workspace without changing the shell's directory.

| Option                | Behavior                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `-m, --model <model>` | Select an Ollama tag; overrides a resumed session's model when supplied                                |
| `--host <url>`        | Ollama host, default `http://localhost:11434`; HTTP(S), without userinfo, query, or fragment           |
| `--no-think`          | Disable reasoning requests; default on                                                                 |
| `-C, --cwd <path>`    | Existing workspace directory; filters `--resume` and `--sessions` when supplied                        |
| `-V, --version`       | Print version and exit                                                                                 |
| `--yolo`              | Auto-approve gated calls; denied tools stay blocked; MCP still requires exact pre-trusted tools        |
| `--resume`            | Newest usable saved session, skipping unavailable directories                                          |
| `--session <id>`      | Exact ID or unique prefix; never substitutes another session; conflicting explicit `--cwd` is an error |
| `--sessions`          | List saved sessions and exit                                                                           |
| `--theme <name>`      | Theme ID or label; overrides saved preferences                                                         |
| `-h, --help`          | Show help and exit                                                                                     |

Interactive conversations require terminal stdin **and** stdout. Otherwise Coral writes an actionable message to stderr and exits 1. Help, version, and session listing work without a TTY. An explicitly requested unavailable or ambiguous session fails; it does not start a new conversation.

## Headless: `coral exec [options] [prompt]`

Shared model, host, thinking, workspace, and version options work before or after `exec`. A nonempty model is required. Exec always runs one ephemeral turn without saving a conversation, prompt history, or interactive telemetry.

```bash
coral exec -m gemma4:31b-mlx -C /path/to/worktree --no-think \
  --permission-profile read-only --output-format json \
  --result-file result.json "Review the changes"
cat prompt.md | coral exec -m gemma4:31b-mlx --prompt-file - --output-format stream-json
```

| Option                           | Behavior                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `[prompt]`                       | Quoted prompt text, mutually exclusive with `--prompt-file`                                                  |
| `--prompt-file <path>`           | UTF-8 file; `-` explicitly reads piped stdin; nonempty, at most 1 MiB, bounded while reading and cancellable |
| `--permission-profile <profile>` | `read-only` (default) or `workspace-write`                                                                   |
| `--output-format <format>`       | `text` (default), `json`, or `stream-json` (NDJSON)                                                          |
| `--result-file <path>`           | Atomically write the version-1 result, including parsed input failures                                       |
| `--ephemeral`                    | Compatibility marker; exec is always ephemeral                                                               |
| `--mcp`, `--no-mcp`              | Opt into pre-trusted, always-allowed MCP tools, or explicitly disable them (default)                         |

Relative prompt-file and result-file paths resolve from the invoking shell directory. Input is never implicitly read from stdin.

### Exit codes

| Outcome                                                      | Code |
| ------------------------------------------------------------ | ---- |
| Completed, help, version                                     | 0    |
| Syntax errors (stderr), runtime errors, result-file failures | 1    |
| Validly parsed input failures: model, cwd, host, prompt      | 2    |
| SIGINT cancellation, including stdin reads                   | 130  |
| SIGTERM cancellation, including stdin reads                  | 143  |

Parsed input failures produce the requested JSON/NDJSON result with empty response and zero usage, plus a stderr explanation. Syntax errors produce stderr only. The version-1 result shape below is unchanged.

### Permission profiles

Every listed tool is set to `always_allow` inside the profile. Approvals still **always return false**, so anything that still requires a prompt (including MCP launch, doom-loop continue, and tools not in the profile) is rejected.

**`read-only`** (same set as read-only subagents):

`read_file`, `grep`, `glob`, `list_files`, `search_code`, `code_intel`, `git_status`, `git_diff`, `git_log`

**`workspace-write`:** those plus `write_file`, `edit_file`, `bash`.

**In neither profile:** `git_add`, `git_commit`, `git_switch`, `git_push`, `task`, `todo_write`.

`--mcp` copies `mcp__*` keys from `resolvePermissions(cwd)` into the map. Only tools that are already launch-trusted **and** `always_allow` can run; launch prompts and `require_approval` MCP calls are rejected. `verifyEdits` is always `false` (project `verify.enabled` is ignored). Thinking requests default to on; `--no-think` disables them.

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
