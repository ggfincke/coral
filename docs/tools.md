# Tools

Coral exposes a fixed built-in catalog to the model, plus optional MCP tools you allowlist. Names below are the **exact** tool names in `src/tools/registry.ts`.

Policy and path-gate summary: [Permissions](permissions.md). MCP names: `mcp__<alias>__<tool>` — [MCP](mcp.md).

TUI labels (Read, Write, Shell, …) are display only.

---

## Catalog at a glance

| Name          | Default policy   | Path gate            | Subagent | Parallel | Approval notes                      |
| ------------- | ---------------- | -------------------- | -------- | -------- | ----------------------------------- |
| `read_file`   | always_allow     | `path`               | yes      | yes      | Outside workspace still prompts     |
| `write_file`  | require_approval | `path` (default `.`) | no       | no       | Outside workspace: not undoable     |
| `edit_file`   | require_approval | `path` (default `.`) | no       | no       | Exact match; optional `replace_all` |
| `grep`        | always_allow     | `path` (default `.`) | yes      | yes      | Needs `rg`                          |
| `glob`        | always_allow     | `path` (default `.`) | yes      | yes      | Needs `rg`                          |
| `list_files`  | always_allow     | `path` (default `.`) | yes      | yes      | Tree, depth cap 5                   |
| `search_code` | always_allow     | no                   | yes      | no       | Local embedding index               |
| `skill`       | always_allow     | no                   | yes      | yes      | Instruction pack; no script exec    |
| `code_intel`  | always_allow     | `path`               | yes      | no       | TS/JS LSP                           |
| `bash`        | require_approval | no                   | no       | no       | Not sandboxed                       |
| `git_status`  | always_allow     | no                   | yes      | yes      |                                     |
| `git_diff`    | always_allow     | no                   | yes      | yes      |                                     |
| `git_log`     | always_allow     | no                   | yes      | yes      |                                     |
| `git_add`     | require_approval | no                   | no       | no       |                                     |
| `git_commit`  | require_approval | no                   | no       | no       | Staged only                         |
| `git_switch`  | require_approval | no                   | no       | no       |                                     |
| `git_push`    | require_approval | no                   | no       | no       | 60s timeout                         |
| `task`        | always_allow     | no                   | no       | no       | Spawns read-only child              |
| `todo_write`  | always_allow     | no                   | no       | no       | Primary session only                |

Subagent set: the ten `yes` rows under Subagent. `coral exec --permission-profile read-only` uses that same set. `workspace-write` adds `write_file`, `edit_file`, `bash` only.

Ripgrep timeout 15s, buffer 5 MiB. Git default timeout 10s except `git_push` (60s). Tool results fed to the model are capped at about 100,000 characters.

---

## File and search

### `read_file`

Read a text file. **Required:** `path` (absolute or relative).

Cap: 1,048,576 bytes. Oversized files tell the model to use `bash` with `head`/`tail`. Missing or unreadable paths error. Binary files are **not** detected — Coral reads UTF-8 and may return decoded garbage. Workspace check as above.

### `write_file`

Create/overwrite a file, creating parent directories. **Required:** `path`, `content`.

In-workspace: refuses content over the 1 MiB undo-capture limit, and refuses if the previous file cannot be read for a snapshot; records a diff and undo snapshot. Outside workspace (after approval): writes, **not undoable**.

### `edit_file`

Surgical replace. **Required:** `path`, `old_string`, `new_string`. Optional `replace_all` (default false).

Fails if `old_string` is empty, equals `new_string`, is missing, or matches more than once unless `replace_all`. Whitespace-tolerant fuzzy match may still apply and mark the call repaired (the model is told to copy exact text next time). Same undo size cap as write for in-workspace results.

### `grep`

Regex search via `rg -n -H --hidden --no-messages --regexp`. **Required:** `pattern`. Optional `path` (default cwd), `include` glob.

Max **200** hits. No matches: `No matches found.` Missing `rg`: install hint `https://github.com/BurntSushi/ripgrep#installation`.

### `glob`

File names via `rg --files --hidden --sortr=modified --glob`. **Required:** `pattern`. Optional `path` (default cwd).

Max **100** paths, newest first. No matches: `No matching files found.`

### `list_files`

Indented tree. Optional `path` (default cwd), `depth` (default **2**, max **5**, minimum 1).

Max **200** entries. Directories show `/`. Symlink directories show `/@` and are **not** recursed. Symlink files show `@`. Skips common noise: `.git`, `node_modules`, `.next`, `.cache`, `dist`, `build`, `__pycache__`, `.venv`, `venv`, `target`, `.DS_Store`, `.idea`, `.vscode`, `coverage`, `.nyc_output`, `.turbo`, `.parcel-cache`.

---

## Semantic search

### `search_code`

Natural-language search over an on-disk embedding index for **this project**. **Required:** nonempty `query` after trim (`search_code requires a non-empty query`). Optional `topK` (default **5**, clamped 1–**20**).

Each search refreshes the index (`refreshDeduped`). Snippets: at most 12 lines / 1,200 characters. Empty: `No semantically similar code chunks found.`

Index path: `CORAL_HOME/retrieval/v3/spaces/<sha256>.sqlite`. Space id is SHA-256 of `coral/embedding-space/v3` plus provider (`ollama` or `mlx`) plus endpoint identity (normalized Ollama host, or the MLX models dir) plus the embedding model's **artifact digest**. Ollama digests come from `/api/tags`; MLX digests come from the worker `model.show` hash over checkpoint files. Missing/ambiguous digest fails closed (no reuse under a mutable tag). Older `retrieval/v2/` files are left in place and never opened.

Indexing limits: 2,000 files, 512 KiB per file, skip binaries, the `list_files` noise set, extra names `.coral` / `.coral-retrieval`, **reject symlinks**. Git repos use `git ls-files -z --cached --others --exclude-standard`. Chunker: 80 lines, 10-line overlap, 6,000 chars.

Default embedding model: `nomic-embed-text` (Ollama). Override with
`CORAL_EMBEDDING_MODEL` (`mlx:<name>`, `ollama:<name>`, or a bare Ollama name)
or project `.coral.json` `retrieval.embeddingModel` / optional
`retrieval.provider`. The environment override selects both model and provider;
conflicting project prefixes/providers fail closed. `/index` and `/index
rebuild` (or `force`) share this indexer. Intended for ordinary project sizes,
not giant monorepos (in-process vector scan).

---

## Skills

### `skill`

Load a discovered skill's instructions. **Required:** `name` (catalog name).
Optional `file` must be under `references/`; the default is `SKILL.md`.

Unknown names return the catalog (not an error). `..`, absolute paths, and symlink escape are errors. Output is sanitized and capped like other tools. Skills cannot grant tools or permissions. Coral does not execute skill `scripts/`. See [Skills](skills.md).

---

## Code intelligence

### `code_intel`

Bundled `typescript-language-server`. **Required:** `operation` (`definition` | `references` | `hover` | `diagnostics`), `path`. Position ops need 1-based integer `line` and `character` ≥ 1 (UTF-16). Diagnostics needs path only. Unsupported path: `code_intel supports .ts, .tsx, .mts, .cts, .js, .jsx, .mjs, and .cjs files`. No service: `code_intel is unavailable in this session`.

The server starts on first use, is shared with `task` subagents, and stops when the owning Agent disposes. Timeouts: 30s startup, 15s requests, 5s diagnostics. Other languages, code actions, rename, and workspace-wide diagnostics are out of scope. See [Architecture](architecture.md).

---

## Shell

### `bash`

**Required:** `command`. Optional `timeout` milliseconds (default **30,000**, not clamped). Output buffer 1 MiB.

Runs in the session cwd. **Not sandboxed.** Network and paths outside the project are allowed once you approve the command (or yolo auto-approves).

---

## Git

Refs/paths starting with `-` are rejected so git does not treat them as options.

### Read

- **`git_status`** — optional `short` (default **true**) → `git status --short` vs `git status`.
- **`git_diff`** — optional `staged`, `stat`, `ref`, `path`. Uses `--staged`, `--stat`, optional ref, `-- path`.
- **`git_log`** — optional `count` (default **10**, not clamped), `oneline` (default **true**), `ref`, `path`. Non-oneline pretty: `%h %s (%an, %ar)`.

### Mutation (always approval-gated by default)

- **`git_add`** — `all:true` → `git add -A`; else `git add -- …paths`. Requires `paths` or `all`.
- **`git_commit`** — required nonempty `message` after trim (`git_commit requires a non-empty message`). Does **not** auto-stage. `git commit -m`.
- **`git_switch`** — required `branch`; optional `create` (default false), `startPoint` (requires `create:true`). Create path runs `git check-ref-format --branch`.
- **`git_push`** — `git push --porcelain`; optional `remote`, `branch` (requires `remote`), `setUpstream` (requires both) → `-u`. Timeout 60s.

`/diff` in the TUI is a user command (`git diff`), not this tool.

---

## Subagents and todos

### `task`

Delegate bounded research. **Required:** nonempty `prompt` after trim (`task requires a non-empty prompt`; the child sees **only** this, not the parent conversation). Optional `description` (3–5 words) is the TUI summary only — **not** forwarded.

Child: 24 tool-round cap; read-only tools listed above; no MCP; no `todo_write`; denies unexpected approval-gated tools; shares LSP and `num_ctx`. Returns a final report. Interrupt/`Esc` aborts the child via the run signal.

### `todo_write`

Replace the whole list each call. **Required:** `todos` array of `{ content, status }` where status is `pending` | `in_progress` | `completed`. **At most** one `in_progress` (zero is allowed). Empty list: `Cleared the task list`. Glyphs: `[ ]` `[~]` `[x]` in `/todo` text; the live panel uses `○` `◐` `●`.

`/todo` and `/todo clear` are the user-facing views. State is per primary Agent and persisted with the session. Undo restores todo snapshots when the turn recorded a change.

---

## MCP tools

Discovered after a trusted launch. Serial execution. Default `require_approval`. Cannot impersonate built-in names or inherit subagent/parallel/path metadata. Not visible to `task`. Full contract: [MCP](mcp.md).

---

## Related

[Permissions](permissions.md) · [Architecture](architecture.md) · [Context](context.md) · [MCP](mcp.md)
