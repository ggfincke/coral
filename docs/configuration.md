# Configuration

Coral reads JSON from two files, environment variables, and CLI flags. Mutable state lives under `CORAL_HOME` (default `~/.coral`). **User config is not relocated** when you set `CORAL_HOME`.

---

## Files

| File | What is read |
|---|---|
| `~/.coral.json` | `permissions`, `mcp` only. Path is always `join(homedir(), '.coral.json')` |
| `<workspace>/.coral.json` | `permissions`, `retrieval`, `context`, `verify` only |
| `CORAL_HOME/prefs.json` | UI prefs; the code writes `theme` |

Unknown top-level keys are ignored. User file ignores `retrieval` / `context` / `verify` even if present. Project file ignores `mcp` even if present.

**Invalid JSON** (missing, unreadable, parse error, non-object): treated as `{}`. No diagnostic for a corrupt whole file. Wrong-typed fields in a section are dropped; valid sibling fields still apply. MCP is stricter about **server entries**: bad servers are excluded and `/mcp` lists issues. If `mcp` exists but `mcp.servers` is not an object: `mcp.servers must be an object`. A corrupt entire `~/.coral.json` yields empty MCP with **no** issues.

Numeric `context.maxNumCtx` is still clamped to supported token bounds later. Strings such as `"32768"` are **not** numbers and are ignored.

---

## Precedence

| Concern | Winner |
|---|---|
| Tool policy | Built-in defaults ← user `permissions` (may loosen defaults) ← project `permissions` (**tighten only**) |
| Context ceiling | `CORAL_NUM_CTX` (integer `> 0`) **replaces** project `context.maxNumCtx` |
| Embedding model | `CORAL_EMBEDDING_MODEL` (nonempty trimmed) else project `retrieval.embeddingModel` else `nomic-embed-text` |
| Verify | Project `verify.enabled` boolean; otherwise `false` |
| MCP servers | User `mcp` only |
| Theme | `--theme` > `prefs.json` > `coral-reef` |
| Ollama host | `--host` else `http://localhost:11434` (not `OLLAMA_HOST`) |
| Model | `--model` else picker / resume session model |
| Think requests | `--no-think` else on |
| Permission mode | `--yolo` else ask |

Project policy rank: `always_allow` < `require_approval` < `always_deny`. A clone can deny `bash`; it cannot silently make a user-gated tool `always_allow`. Unknown tool names (including `mcp__…` you have not set) default to `require_approval`.

---

## When config is pinned

Coral does **not** live-reload JSON on an existing Agent:

| Section | When resolved |
|---|---|
| Permissions + verify | Agent construction |
| MCP config snapshot | Interactive session hook mount (app start) |
| Context window | First need for this Agent/model; `/model` re-resolves |
| Retrieval / embedding | Whenever an indexer is constructed (`search_code` or `/index`) |

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
    "maxNumCtx": 32768
  },
  "verify": {
    "enabled": true
  }
}
```

| Key | Type | Default if missing/malformed |
|---|---|---|
| `permissions` | map of tool name → policy | built-in + user |
| `retrieval.embeddingModel` | trimmed string | `nomic-embed-text` unless env set |
| `context.maxNumCtx` | number `> 0` (floored) | no extra ceiling (memory + native only) |
| `verify.enabled` | boolean | `false` (non-booleans, including `"true"`, → false) |

`context.maxNumCtx` is a **ceiling**, not a fixed allocation. See [Context](context.md).

`verify.enabled` only affects **new** Agents. `/verify on|off` toggles the live Agent and is not written back to this file. `coral exec` always uses `verifyEdits: false`.

---

## Environment variables

Coral-owned reads in `src/`:

| Variable | Behavior |
|---|---|
| `CORAL_HOME` | If set and nonempty, `resolve` that path (cwd-relative allowed). Else `~/.coral`. Relocates **mutable state only**, not `~/.coral.json` |
| `CORAL_NUM_CTX` | `parseInt` base 10. Used iff finite and `> 0`. Wins over project `maxNumCtx`. Still floored at **8192** unless native is smaller, and capped by native/memory. Request prompts are separately capped at **32,768** tokens |
| `CORAL_EMBEDDING_MODEL` | Trimmed nonempty wins over project embedding model |

No other `CORAL_*` variables are read by the product. Coral does not read `OLLAMA_HOST`.

MCP `passEnv` names are read from `process.env` at launch. **Unset** names disable that server for the session. An empty string is not treated as missing.

The bundled TypeScript language server inherits a copy of `process.env`.

---

## `CORAL_HOME` layout

Default root: `~/.coral`. Directories `0o700`, session/trust/index files typically `0o600`.

| Path | Contents |
|---|---|
| `sessions/<8hex>.json` | Authoritative conversations, todos, bounded undo/redo |
| `history.jsonl` | Append-only prompt history; navigation uses newest 500 valid rows |
| `prefs.json` | Whole-file last-writer-wins; `theme` |
| `telemetry.json` | Legacy baseline **read**; new interactive deltas go to `telemetry.d/` |
| `telemetry.d/<uuid>.json` | Immutable per-Agent-lifetime reliability counters |
| `eval-telemetry.json` + `eval-telemetry.d/` | Eval harness only (`npm run eval -- --save-telemetry`), not the interactive CLI |
| `mcp-trust.json` | Legacy launch-trust baseline (read) |
| `mcp-trust.d/<alias>.json` | Atomic per-alias approvals (write path for new trust) |
| `retrieval/v2/spaces/<64-hex>.sqlite` | Semantic indexes, one per verified embedding space |
| `retrieval/index.sqlite` | Legacy cache; current Coral does **not** open it |

Multiple Coral processes may share one `CORAL_HOME`. Session discovery scans files (a stale index cannot hide a session). Same session ID: complete-file last-writer-wins. Telemetry deltas and per-alias trust avoid unrelated lost updates. Preferences are whole-file LWW. History is not rewritten on ordinary reads.

Retrieval uses SQLite WAL and a bounded busy wait. Coral does not delete old caches while another process might have them open. To drop indexes: quit every Coral, then remove files under `CORAL_HOME/retrieval/`.

---

## CLI flags that are not JSON

Think, yolo, host, model, `--theme` for this process: [CLI](cli.md). Slash-command toggles (`/verify`, `/permissions`, `/theme`) are documented in [TUI](tui.md).

---

## Project prompt files (not `.coral.json`)

At request time Coral may inject workspace files into the system prompt, in this priority order: `.coral.md`, `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `requirements.txt`, `pom.xml`, `build.gradle`, `Makefile`, `Dockerfile`, `docker-compose.yml` / `.yaml`, `.env.example`.

Per-file cap 8,192 bytes. Total budget scales with the pinned window (~1/8, clamped 4,096–32,768 characters) and is the first thing dropped when the request does not fit. Injected text **cannot grant tools**.

---

## Related

[Permissions](permissions.md) · [MCP](mcp.md) · [Context](context.md) · [Sessions](sessions.md) · [CLI](cli.md) · [Architecture](architecture.md)
