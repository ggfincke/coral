# Configuration

Coral reads JSON from two files, environment variables, and CLI flags. Mutable state lives under `CORAL_HOME` (default `~/.coral`). **User config is not relocated** when you set `CORAL_HOME`.

---

## Files

| File                      | What is read                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `~/.coral.json`           | `permissions`, `tools`, `providers`, `mcp` only. Path is always `join(homedir(), '.coral.json')` |
| `<workspace>/.coral.json` | `permissions`, `tools`, `retrieval`, `context`, `verify` only                                    |
| `CORAL_HOME/prefs.json`   | UI prefs; the code writes `theme`                                                                |

Unknown top-level keys are ignored. User file ignores `retrieval` / `context` / `verify` even if present. Project file ignores `mcp` even if present.

**Invalid JSON** (missing, unreadable, parse error, non-object): treated as `{}`. No diagnostic for a corrupt whole file. Wrong-typed fields in a section are dropped; valid sibling fields still apply. MCP is stricter about **server entries**: bad servers are excluded and `/mcp` lists issues. If `mcp` exists but `mcp.servers` is not an object: `mcp.servers must be an object`. A corrupt entire `~/.coral.json` yields empty MCP with **no** issues.

Numeric `context.maxNumCtx` is still clamped to supported token bounds later. Strings such as `"32768"` are **not** numbers and are ignored.

---

## Precedence

| Concern          | Winner                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Tool policy      | Built-in defaults ← user `permissions` (may loosen defaults) ← project `permissions` (**tighten only**)                   |
| Local prompt cap | `CORAL_MAX_PROMPT_TOKENS` (integer `> 0`) **replaces** project `context.maxPromptTokens`; default `32768`                 |
| Context ceiling  | `CORAL_NUM_CTX` (integer `> 0`) **replaces** project `context.maxNumCtx`                                                  |
| Embedding model  | `CORAL_EMBEDDING_MODEL` (nonempty trimmed) else project `retrieval.embeddingModel` else `nomic-embed-text`                |
| Tool profile     | User + project `tools.disabled` union; project `tools.localTask` and `tools.localGitWrite` override user; default `false` |
| Verify           | Project `verify.enabled` boolean; otherwise `false`                                                                       |
| MCP servers      | User `mcp` only                                                                                                           |
| Theme            | `--theme` > `prefs.json` > `coral-reef`                                                                                   |
| Ollama host      | `--host` else `http://localhost:11434` (not `OLLAMA_HOST`)                                                                |
| Model            | `--model` else picker / resume session model                                                                              |
| Think requests   | `--no-think` else on                                                                                                      |
| Permission mode  | `--yolo` else ask                                                                                                         |

Project policy rank: `always_allow` < `require_approval` < `always_deny`. A clone can deny `bash`; it cannot silently make a user-gated tool `always_allow`. Unknown tool names (including `mcp__…` you have not set) default to `require_approval`.

---

## When config is pinned

Coral does **not** live-reload JSON on an existing Agent:

| Section                      | When resolved                                                  |
| ---------------------------- | -------------------------------------------------------------- |
| Permissions + tools + verify | Agent construction                                             |
| MCP config snapshot          | Interactive session hook mount (app start)                     |
| Local prompt cap             | Agent construction                                             |
| Context window               | First need for this Agent/model; `/model` re-resolves          |
| Retrieval / embedding        | Whenever an indexer is constructed (`search_code` or `/index`) |

`/new` and `/clear` keep the same Agent, so they do **not** re-read `.coral.json`. Restart Coral (or replace the Agent via resume/model flows that construct a new one) to pick up permission file edits. When `/mcp` lists at least one server, the footer says `Config changes require a new Coral session.`

Empty `mcp: {}` (object without a `servers` object) yields issue `mcp.servers must be an object`. Working directory for launches is always `os.homedir()`; there is no `launchCwd` JSON field.

---

## User `~/.coral.json`

```json
{
  "permissions": {
    "bash": "require_approval",
    "mcp__github__get_me": "always_allow"
  },
  "mcp": {
    "servers": {
      "github": {
        "command": "docker",
        "args": ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],
        "enabledTools": ["get_me"],
        "yoloTools": ["get_me"],
        "passEnv": ["GITHUB_PERSONAL_ACCESS_TOKEN"],
        "startupTimeoutMs": 30000,
        "toolTimeoutMs": 60000
      }
    }
  }
}
```

MCP field contract: [MCP](mcp.md). Permission values: `always_allow` | `require_approval` | `always_deny`.

Hosted model tuning lives only in the user file, so a cloned repository cannot raise spend:

```json
{
  "providers": {
    "anthropic": { "effort": "high", "maxContextTokens": 200000 },
    "openai": { "effort": "medium", "maxContextTokens": 128000 }
  }
}
```

| Key                                 | Type                                                    | Default if missing/malformed |
| ----------------------------------- | ------------------------------------------------------- | ---------------------------- |
| `providers.<name>.effort`           | `low` \| `medium` \| `high` \| `xhigh` \| `max`         | `high`                       |
| `providers.<name>.maxContextTokens` | number `> 0` (floored), capped by the model's own limit | `200000`                     |

Coral resends history on every turn, so `maxContextTokens` is effectively the per-turn cost ceiling. `--no-think` maps to effort `low` on Anthropic and `none` on OpenAI models that support it.

Skills catalog preferences also live only in the user file:

```json
{
  "skills": {
    "localAllowlist": ["code-review", "simplification-review"]
  }
}
```

`skills.localAllowlist` is an optional string array of skill names to show in
Ollama prompts, matched case-insensitively. An empty array hides the catalog;
missing or malformed values allow all discovered names within the prompt budget.
Unknown names are ignored. Hosted catalogs remain unchanged. This preference
does not restrict the `skill` tool, skill listings, or slash commands, and is
ignored in project config. Catalog descriptions are capped at 80 characters for
Ollama and 120 for hosted models. See [Skills](skills.md).

---

## Project `<workspace>/.coral.json`

```json
{
  "permissions": {
    "bash": "always_deny",
    "git_push": "always_deny",
    "write_file": "require_approval"
  },
  "retrieval": {
    "embeddingModel": "nomic-embed-text"
  },
  "context": {
    "maxNumCtx": 32768,
    "maxPromptTokens": 16384
  },
  "verify": {
    "enabled": true
  }
}
```

| Key                        | Type                           | Default if missing/malformed                        |
| -------------------------- | ------------------------------ | --------------------------------------------------- |
| `permissions`              | map of tool name → policy      | built-in + user                                     |
| `retrieval.embeddingModel` | trimmed string                 | `nomic-embed-text` unless env set                   |
| `context.maxPromptTokens`  | finite number `>= 1` (floored) | `32768`                                             |
| `context.maxNumCtx`        | number `> 0` (floored)         | no extra ceiling (memory + native only)             |
| `verify.enabled`           | boolean                        | `false` (non-booleans, including `"true"`, → false) |

`context.maxPromptTokens` limits local request and compaction prompts to the smaller of this cap and the pinned context window minus the applicable response reserve. It does not change the pinned window or apply to hosted models. Invalid values fall back to `32768`.

`context.maxNumCtx` is a **ceiling**, not a fixed allocation. See [Context](context.md).

`verify.enabled` only affects **new** Agents. `/verify on|off` toggles the live Agent and is not written back to this file. `coral exec` always uses `verifyEdits: false`.

---

## Tool profiles

Both user and project files accept:

```json
{
  "tools": {
    "disabled": ["search_code"],
    "localTask": false,
    "localGitWrite": false
  }
}
```

`tools.disabled` removes built-in tools from the Agent's active catalog, schemas, and prompt guidance. User and project lists are combined, so a project cannot re-enable a tool disabled by the user. Entries must be exact built-in tool names; unknown names, non-string entries, and malformed fields are silently ignored. MCP tools remain controlled by the user MCP configuration and permissions. Disabled built-in names remain reserved and cannot be claimed by MCP tools.

`task` is omitted for Ollama models unless `tools.localTask` is `true`. A valid project boolean overrides the user boolean; the default is `false`. An explicit `"task"` in either disabled list always wins. Switching models rebuilds the catalog for the selected provider and retires the previous model's MCP tools. Switching to a hosted provider restores `task` only if it was included in the Agent's original tool set and was not explicitly disabled. Tool profile config is read at Agent construction and is not reloaded on model switches.

`git_add`, `git_commit`, `git_switch`, and `git_push` are omitted for Ollama models unless `tools.localGitWrite` is `true`, with the same precedence as `localTask`. Local models keep `git_status`, `git_diff`, and `git_log` and can still run Git through `bash`, which asks for approval. Leaving the four write tools out removes their schemas and most of the "Committing changes" prompt rules, about 700 tokens of fixed prompt. Hosted models always get them unless they are disabled.

`search_code` is also omitted for Ollama models when the configured embedding model is not in the Ollama model list at session start. Pull the model and start a new session (or switch models) to get it back. If the model list cannot be read, the tool stays.

---

## Environment variables

Coral-owned reads in `src/`:

| Variable                  | Behavior                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CORAL_HOME`              | If set and nonempty, `resolve` that path (cwd-relative allowed). Else `~/.coral`. Relocates **mutable state only**, not `~/.coral.json`                                                                                                    |
| `CORAL_NUM_CTX`           | `parseInt` base 10. Used iff finite and `> 0`. Wins over project `maxNumCtx`. Still floored at **8192** unless native is smaller, and capped by native/memory. Local request prompts default to **32,768** tokens, configurable separately |
| `CORAL_MAX_PROMPT_TOKENS` | `parseInt` base 10. Used iff finite and `> 0`; otherwise falls back to project `context.maxPromptTokens`, then `32768`. Local models only; bounded by the window minus response reserve                                                    |
| `CORAL_EMBEDDING_MODEL`   | Trimmed nonempty wins over project embedding model                                                                                                                                                                                         |
| `ANTHROPIC_API_KEY`       | Enables `anthropic/<id>` models and lists them in the picker. Read when a hosted model is first used                                                                                                                                       |
| `OPENAI_API_KEY`          | Enables `openai/<id>` models and lists them in the picker. Read when a hosted model is first used                                                                                                                                          |
| `AGENTS_HOME`             | Shared Agents directory; defaults to `~/.agents`. Personal skills use `skills/`, and standing instructions use `AGENTS.md`                                                                                                                 |

On Linux, hosted credentials can also be stored in the desktop keyring with
`secret-tool`, using attributes `application coral` and `provider anthropic` or
`provider openai`. Environment variables take precedence over keyring entries.

No other `CORAL_*` variables are read by the product. Coral does not read `OLLAMA_HOST`.
`AGENTS_HOME` is separate from `CORAL_HOME` and is not relocated with it.

MCP `passEnv` names are read from `process.env` at launch. **Unset** names disable that server for the session. An empty string is not treated as missing.

The bundled TypeScript language server inherits a copy of `process.env`.

---

## `CORAL_HOME` layout

Default root: `~/.coral`. Directories `0o700`, session/trust/index files typically `0o600`.

| Path                                            | Contents                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `sessions/<8hex>.json`                          | Authoritative conversations, todos, bounded undo/redo                                                                 |
| `history.jsonl`                                 | Append-only prompt history; navigation uses newest 500 valid rows                                                     |
| `prefs.json`                                    | Whole-file last-writer-wins; `theme`                                                                                  |
| `telemetry.json`                                | Legacy baseline **read**; new interactive deltas go to `telemetry.d/`                                                 |
| `telemetry.d/<uuid>.json`                       | Immutable per-Agent-lifetime reliability counters                                                                     |
| `eval-telemetry.json` + `eval-telemetry.d/`     | Eval harness only (`npm run eval -- --save-telemetry`), not the interactive CLI                                       |
| `mcp-trust.json`                                | Legacy launch-trust baseline (read)                                                                                   |
| `mcp-trust.d/<alias>.json`                      | Atomic per-alias approvals (write path for new trust)                                                                 |
| `tool-grants.d/<64-hex>.json`                   | Persistent per-workspace tool grants from `(p)`; see [Permissions](permissions.md#session-and-workspace-grants)       |
| `retrieval/v2/spaces/<64-hex>.chunks-v2.sqlite` | Semantic indexes, isolated by embedding space and chunker version                                                     |
| `retrieval/index.sqlite`                        | Legacy cache; current Coral does **not** open it                                                                      |
| `jobs/<8hex>/`                                  | Durable task record, events, checkpoints, command output, and worktree; see [Durable tasks](jobs.md#where-data-lives) |

Durable tasks also use a private control directory, `/tmp/coral-jobs-<uid>-<hash>/`, derived from the resolved `CORAL_HOME`; one supervisor serves each `CORAL_HOME`.

Multiple Coral processes may share one `CORAL_HOME`. Session discovery scans files (a stale index cannot hide a session). Same session ID: complete-file last-writer-wins. Telemetry deltas and per-alias trust avoid unrelated lost updates. Preferences are whole-file LWW. History is not rewritten on ordinary reads.

Retrieval uses SQLite WAL and a bounded busy wait. Older `retrieval/v2/spaces/<64-hex>.sqlite` files remain untouched; current Coral builds a separate cache on the first search or `/index`. Coral does not delete old caches while another process might have them open. To drop indexes: quit every Coral, then remove files under `CORAL_HOME/retrieval/`.

---

## CLI flags that are not JSON

Think, yolo, host, model, `--theme` for this process: [CLI](cli.md). Slash-command toggles (`/verify`, `/permissions`, `/theme`) are documented in [TUI](tui.md).

---

## Project prompt files (not `.coral.json`)

At request time Coral injects one project instruction file into the system prompt: the first of `.coral.md`, `AGENTS.md`, or `CLAUDE.md` that exists. READMEs, manifests, and the directory tree are not loaded; the model reads them with tools when it needs them. The prompt always carries a short root summary (project name, project type detected from root manifests, top-level entries).

Cap 8,192 bytes. Total budget scales with the pinned window (~1/8, clamped 4,096–32,768 characters) and is the first thing dropped when the request does not fit. Injected text **cannot grant tools**.

---

## Related

[Permissions](permissions.md) · [MCP](mcp.md) · [Context](context.md) · [Sessions](sessions.md) · [CLI](cli.md) · [Architecture](architecture.md)
