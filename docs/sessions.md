# Sessions

Coral saves conversations as JSON under `CORAL_HOME/sessions/` (default `~/.coral/sessions/`). Interactive turns persist after completion. `coral exec` never writes a session.

---

## Identifiers

- 8 lowercase hex characters (`[0-9a-f]{8}`), from 4 random bytes
- Filename `{id}.json` must match `meta.id`
- No uniqueness check before write (collision would overwrite)

Title is derived from the first user message (ellipsized to 80 characters), or `(empty session)`.

---

## What is stored

`SessionData`:

- **meta:** `id`, `model`, `cwd`, `createdAt`, `updatedAt`, `title`, `messageCount` (non-system messages), optional `compactionCount`, `lastCompactedAt`
- **messages:** `system` \| `user` \| `assistant` \| `tool` with `content`; optional `displayContent`, `thinking`, `tool_name`, `tool_calls`, `attachmentReport`
- **todos:** `{ content, status }` with `pending` \| `in_progress` \| `completed`
- **undo / redo:** up to **10** live-tail turns; persisted JSON byte cap **8 MiB**. File `before`/`after` snapshots can duplicate secrets. Aligned undo may omit redundant `messages` and rehydrate from history; redo always stores messages

Invalid files are skipped on list/load.

### Not stored in the session file

Think flag, ask/yolo, `/verify`, pinned `num_ctx`, Ollama token totals, reliability counters, MCP processes, theme, prompt-history JSONL, transcript UI scroll.

On restore, Coral keeps the **new** system prompt (current model and tools), not the saved system message. Frozen compaction prefix is reconstructed from `[Conversation handoff` markers in messages.

---

## When Coral writes

- After every completed Agent **turn**
- After `/compact`, `/undo`, `/redo`, `/todo clear`, `/new` (save then unbind), `/resume` (save current first), `/model` (persist current)
- Skipped if there are zero non-system messages **and** no bound session id (`empty`)

Writes: unique same-dir temp + rename, file mode `0o600`. Concurrent saves of the same ID are whole-file last-writer-wins (no merge).

Discovery lists `sessions/*.json`. A legacy `sessions/index.json` is not read or written.

---

## List, resume, rename, new

| Action | Prefix id? | Cwd must exist? | Notes |
|---|---|---|---|
| `coral --sessions` | n/a | n/a | All sessions, newest `updatedAt` first, then exit. Hint: `coral --session <id>` |
| `/sessions [n]` (`/ls`) | n/a | n/a | Default **10**. Hint: `/resume <id>` |
| `coral --resume` | n/a | **yes** | Newest session only. Missing cwd → **exit 1**, no fallback to the next session |
| `coral --session <id>` | **no** (exact) | **yes** | Wins over `--resume` |
| `/resume [id]` | **yes** | **yes** | No args: newest **other** than current. Saves current first; save error cancels resume |
| `/rename <title>` | n/a | n/a | Needs a bound session |
| `/new` | n/a | n/a | Save first; on save error/stale **abort** (`Current session could not be saved; the new conversation was not started.`). Success: `clearHistory` + unbind |
| `/clear` (`/reset`) | n/a | n/a | Clear history/todos/undo/metrics, unbind. Does not rewrite or delete the old file |

`--model` plus `--resume` / `--session`: Agent is built with the **CLI model** and restored messages (picker skipped). `/resume` uses the **session file's** `meta.model`.

There is **no delete-session command**. `/clear` and `/new` leave the old file on disk. “Retirement” in the runtime means MCP managers and Agent dispose, not garbage-collecting session JSON.

If the stored cwd is gone: CLI prints `Cannot resume session {id}.` / `Working directory no longer exists: {cwd}`; TUI shows `Session unavailable: {id}`.

---

## Multi-process

Several Coral processes may share `CORAL_HOME`. Session files are complete snapshots. Do not expect merged histories if two processes write the same id.

---

## Privacy

Session JSON is local. Coral does not upload it.

If `--host` points at a non-local Ollama server, prompts, attachments, tool results, and history go to that server. If MCP is enabled, model-generated arguments go to that subprocess (and onward to whatever it calls).

Treat `CORAL_HOME/sessions/` like the workspace: undo snapshots can contain file contents, including secrets.

Relocate everything in this table (and other `CORAL_HOME` files) with `CORAL_HOME`. User config stays `~/.coral.json`. See [Configuration](configuration.md).

---

## Related

[CLI](cli.md) · [TUI](tui.md) · [Context](context.md) · [Architecture](architecture.md) · [Troubleshooting](troubleshooting.md)
