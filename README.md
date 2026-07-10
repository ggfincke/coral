# Coral

Coral is a local-first CLI/TUI coding agent powered by Ollama. It can inspect a
codebase, search by text or meaning, edit files, run commands, work with Git,
delegate read-only research, and preserve multi-turn sessions from a terminal.

Coral has no cloud API or remote telemetry. Model requests go only to the Ollama
host you configure (`http://localhost:11434` by default), and Coral's reliability
telemetry stays in local files under `CORAL_HOME`.

> Coral is pre-1.0 and built for capable local models. Interfaces, session data,
> and configuration may still change between minor releases.

## Requirements

- Node.js 24 or newer
- A running [Ollama](https://ollama.com/) server
- At least one model already pulled into Ollama
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for the `grep` and
  `glob` tools
- Optional: `nomic-embed-text` (or another configured Ollama embedding model)
  for semantic code search

TypeScript/JavaScript code intelligence is bundled with Coral; it does not need
a separately installed language server.

## Quick start

Coral is currently run from a source checkout:

```bash
git clone https://github.com/ggfincke/coral.git
cd coral
npm install
npm run dev
```

The startup picker lists models already installed in Ollama. Pass one directly
when you do not want the picker:

```bash
npm run dev -- --model gemma4:31b-mlx
```

To run the compiled CLI:

```bash
npm run build
npm start
```

For semantic search, pull the default embedding model once:

```bash
ollama pull nomic-embed-text
```

## CLI options

| Option                  | Behavior                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| `-V`, `--version`       | Print the Coral version                                                          |
| `-m`, `--model <model>` | Use an installed Ollama model without opening the picker                         |
| `--host <url>`          | Set the Ollama host; defaults to `http://localhost:11434`                        |
| `--no-think`            | Disable streamed reasoning requests                                              |
| `--yolo`                | Auto-approve approval-gated calls; configured `always_deny` policies still block |
| `--resume`              | Resume the most recent usable session                                            |
| `--session <id>`        | Resume one exact session ID                                                      |
| `--sessions`            | List saved sessions and exit                                                     |
| `--theme <name>`        | Select a color theme; `/theme` lists available names                             |
| `-h`, `--help`          | Show CLI help                                                                    |

## Interactive use

- Type a normal prompt to start an agent turn.
- Type `/` to autocomplete slash commands.
- Type `@` to pick a project file. Mentioned text files are attached to that
  turn within a bounded context budget.
- Press `Ctrl+P` to search commands and keybindings in the command palette.
- Approval boxes show pending write/edit diffs when a preview is available.
- Press `Ctrl+C` or `Esc` during a run to interrupt it. The same keys exit when
  Coral is idle.
- Use `PageUp`/`PageDown` to move through the transcript and Up/Down to recall
  input history. Completion menus temporarily own arrows, Tab, Enter, and Esc.

### Slash commands

| Command                                        | Behavior                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `/help`                                        | List commands and keybindings                                        |
| `/clear` (`/reset`)                            | Clear conversation history and the transcript                        |
| `/compact`                                     | Summarize older conversation history to free context                 |
| `/status`                                      | Show model, session, token, context, permission, and Git branch info |
| `/model [name]`                                | Open the model picker or switch to a named installed model           |
| `/permissions [ask\|yolo]` (`/perm`, `/perms`) | Show or change approval mode                                         |
| `/verify [on\|off]`                            | Toggle the post-edit read-only self-check                            |
| `/theme [name]`                                | List or switch color themes                                          |
| `/undo`                                        | Remove the latest live turn and safely revert captured edits         |
| `/redo`                                        | Restore the latest undone turn and captured edits                    |
| `/diff`                                        | Render the current Git diff                                          |
| `/copy [code]`                                 | Copy the last response or its last fenced code block                 |
| `/todo [clear]`                                | Show or clear the model-maintained task list                         |
| `/index [rebuild]`                             | Refresh or fully rebuild the semantic code index                     |
| `/sessions [count]` (`/ls`)                    | List recent saved sessions                                           |
| `/resume [id]`                                 | Resume a saved session; no ID selects the latest usable one          |
| `/rename <title>`                              | Rename the current saved session                                     |
| `/new`                                         | Save the current session and start a new conversation                |
| `/telemetry`                                   | Show local lifetime reliability counters per model                   |
| `/exit` (`/quit`)                              | Exit Coral                                                           |

### Keybindings

| Keys            | Behavior                              |
| --------------- | ------------------------------------- |
| `Ctrl+P`        | Open the command palette              |
| `Ctrl+Y`        | Toggle `ask` / `yolo` permission mode |
| `Ctrl+T`        | Toggle streamed reasoning visibility  |
| `Ctrl+C`        | Interrupt a run, or exit while idle   |
| `Esc`           | Interrupt a run, or exit while idle   |
| Up/Down         | Navigate persistent input history     |
| PageUp/PageDown | Page through the transcript           |

## Agent capabilities

Coral exposes a small structured toolset to the model:

- File reads, writes, surgical edits, directory listings, text search, and glob
  search
- Git status, diff, log, add, commit, branch switching, and push
- Shell execution with bounded output, timeouts, and interrupt support
- Semantic `search_code` over a local Ollama embedding index
- TypeScript/JavaScript `code_intel` for definitions, references, hover/type
  information, and per-file diagnostics
- A read-only `task` subagent for bounded research that should not consume the
  parent conversation's context
- A persistent `todo_write` plan rendered in the TUI

`code_intel` starts its bundled TypeScript language server only on first use,
shares it with read-only subagents, and shuts it down when Coral disposes the
owning Agent. It supports `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`,
and `.cjs`. Other languages, code actions, rename/refactor operations, and
workspace-wide diagnostics are not part of the current MVP.

## Permissions and safety

The default policy auto-allows read/search/code-intelligence operations and
requires approval for file mutations, shell commands, and Git mutations.
Project and user configuration can set any tool to:

- `always_allow`
- `require_approval`
- `always_deny`

`yolo` skips prompts for approval-gated calls; it does not override
`always_deny`. It is not a sandbox. The `bash` tool runs directly on the host and
can access the network and files outside the project.

File, search, and code-intelligence tools request separate approval for explicit
paths outside the active workspace even when their normal policy is
`always_allow`. Symlink paths that escape the workspace fail closed.

Undo/redo verifies that the current file still matches Coral's recorded state
before changing it. Session snapshots used by undo can duplicate edited file
contents, including secrets, under `~/.coral/sessions/` (or `CORAL_HOME`). Treat
that directory with the same care as the workspace.

## Configuration

Coral reads JSON configuration from two places:

- `~/.coral.json`: user-level permission defaults only
- `<workspace>/.coral.json`: project permissions plus retrieval, context, and
  verification settings

Project permission settings may tighten user/default policy but cannot loosen
it. For example, a cloned project may deny `bash`, but it cannot silently make a
user-gated tool auto-allowed.

Example project `.coral.json`:

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

`context.maxNumCtx` is a ceiling, not a fixed allocation. Coral pins the largest
window that fits its memory-aware budget and the model's native limit. The
resolved window remains stable for the session so Ollama does not reload the
runner between turns.

### Environment variables

| Variable                | Behavior                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| `CORAL_HOME`            | Move mutable Coral state from `~/.coral` to another directory                    |
| `CORAL_NUM_CTX`         | Override the project context-window ceiling; environment wins over `.coral.json` |
| `CORAL_EMBEDDING_MODEL` | Override the semantic embedding model; environment wins over `.coral.json`       |

## Local data and privacy

By default Coral stores:

| Path                              | Contents                                                         |
| --------------------------------- | ---------------------------------------------------------------- |
| `~/.coral/sessions/`              | Saved conversations, todo state, and bounded undo/redo snapshots |
| `~/.coral/history.jsonl`          | Prompt history                                                   |
| `~/.coral/prefs.json`             | Mutable UI preferences such as the selected theme                |
| `~/.coral/telemetry.json`         | Interactive per-model reliability counters                       |
| `~/.coral/eval-telemetry.json`    | Optional eval-harness reliability counters                       |
| `~/.coral/retrieval/index.sqlite` | Local semantic code index and embeddings                         |

`CORAL_HOME` relocates every path in this table. The separate read-only user
configuration remains `~/.coral.json`.

Coral does not upload these files. If you set `--host` to a non-local Ollama
server, prompts, attached files, tool results, and conversation context are sent
to that configured server.

## Development

```bash
npm run typecheck -- --pretty false
npm run format:check
npm test
npm run build
npm run typecheck:scripts
npm run check:dev-tools
npm run check:changelog
npm audit --audit-level=high
```

See [scripts/README.md](scripts/README.md) for maintenance/research tooling and
[tests/scripts/eval/README.md](tests/scripts/eval/README.md) for the live-model
evaluation harness.

## Known limitations

- Coral is pre-1.0 and currently optimized for large, capable local models.
- TypeScript/JavaScript are the only languages with LSP-backed code intelligence.
- `bash` is not sandboxed; use `ask` mode with models you do not fully trust.
- Semantic search uses an in-process vector scan and is intended for ordinary
  project sizes, not giant monorepos.
- The project does not currently declare a software license.
