# TUI

Interactive Coral is an Ink app. Type a prompt to run a turn. Built-in slash commands and keybindings are handled by Coral, not the model. Discovered skills are also slash commands (`/simplification-review`); those start a chat turn.

`/help` prints the same command list (canonical order), then discovered skills, then advertised keybindings. Footer: `Type /command to run. Skill names start a chat turn; other commands are not sent to the model.`

---

## Header and status

Header: `coral · {model or 'pick a model'} · ask|YOLO`. `session {id}` appears only once a session is bound. `{n} messages` appears only when the count is greater than 0.

While a run is active, the status line uses stages such as `waiting for model`, `thinking`, `responding`, `compacting context`, `running {tool}`, or `ready`, plus a context-occupancy gauge and last-turn tok/s when known. Idle left side: occupancy gauge (or `ready`), last-turn throughput, and `N tok session`. Idle hints include `ctrl+p commands`, `/help`, `esc quits`, and `⚠ yolo` in yolo mode. During a run: `ctrl+c interrupts`. Other strings: `command palette` / `enter runs · esc closes`; picker `loading models…` / `press r to retry` / `N models available`; `scrollback`; `switching model…` / `finishing model update…` / `finishing permission update…` / `finishing session update…`; `running command…`; `cleanup in progress`.

Welcome (`welcome to coral`) shows only while the transcript is empty.

The todo panel above the prompt shows the live `todo_write` list (max **8** rows; glyphs `○` pending, `◐` in progress, `●` completed). `/todo` is the command view of the same state.

---

## Slash commands

Parser: input must start with `/`; the name is lowercased; the first space splits arguments. Unknown: `Unknown command: /name` plus a hint to `/help`. Skill names that collide with a built-in (or alias) keep the built-in. A unique skill prefix that is not also a built-in prefix (`/sim` → `simplification-review`) starts that skill; an ambiguous prefix prints the matching names.

Aliases work for dispatch and `/` completion. The command palette runs the **canonical** name (`/permissions`, not `/perm`).

| Command        | Aliases           | Arguments                | What it does                                                                                                                                                                                                          |
| -------------- | ----------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/help`        |                   |                          | List commands and advertised keybindings                                                                                                                                                                              |
| `/clear`       | `/reset`          |                          | Clear conversation history, todos, and undo. Unbinds the session. Does **not** delete the session file                                                                                                                |
| `/compact`     |                   |                          | Summarize older history. TUI needs at least 4 non-system messages. Clears undo. See [Context](context.md)                                                                                                             |
| `/status`      |                   |                          | Model, permission mode, session id, message count, estimated tokens, Ollama prompt/decode counts and speeds when present, compaction count, frozen-prefix coverage, repair counters, self-check flag, cwd, git branch |
| `/mcp`         |                   |                          | Observational MCP status. Never launches a server. See [MCP](mcp.md)                                                                                                                                                  |
| `/skills`      |                   |                          | Observational skill catalog. Never installs or loads a package. Type `/name` to run one. See [Skills](skills.md)                                                                                                      |
| `/<skill>`     |                   | optional extra text      | Each discovered skill is a slash command (`/simplification-review`). Starts a turn that loads it via the `skill` tool and follows it. Extra text is additional instructions. Built-ins win on name collision          |
| `/model`       |                   | none or tag              | No args: reopen picker. Else exact tag, then unique prefix among installed models                                                                                                                                     |
| `/permissions` | `/perm`, `/perms` | none, `ask`, `yolo`      | Show or set mode. MCP catalog for the new mode starts on the **next chat turn**                                                                                                                                       |
| `/verify`      |                   | none, `on`, `off`        | Post-edit self-check. Off by default. Not written to `.coral.json`                                                                                                                                                    |
| `/theme`       |                   | none or name/label       | List or switch. `/theme` writes `prefs.json`. Match is case-insensitive id **or** label                                                                                                                               |
| `/undo`        |                   |                          | Revert last live turn and captured in-workspace file/todo edits. Session JSON can duplicate file contents (including secrets)                                                                                         |
| `/redo`        |                   |                          | Restore the last undone turn                                                                                                                                                                                          |
| `/diff`        |                   |                          | `git diff` of the working tree. Empty → `No uncommitted changes`. Failure → `Not a git repository, or git is not installed`                                                                                           |
| `/copy`        |                   | optional `code`          | Copy last assistant response, or its last fenced code block                                                                                                                                                           |
| `/todo`        |                   | none or `clear`          | Show the model-maintained list, or clear it and save                                                                                                                                                                  |
| `/index`       |                   | none, `rebuild`, `force` | Incremental semantic index, or full rebuild (`rebuild` and `force` are equivalent)                                                                                                                                    |
| `/sessions`    | `/ls`             | optional positive int    | Recent sessions. Default **10** if missing or invalid                                                                                                                                                                 |
| `/resume`      |                   | none or id/prefix        | Prefix match allowed. No args: newest **other** than current. Saves current first; save error cancels (`Current session could not be saved; resume was canceled.`). Cwd must still exist                              |
| `/rename`      |                   | title                    | Rename the bound session. No args: print current id/title and `Usage: /rename <new title>`. No session: `No active session to rename. Send a message first.`                                                          |
| `/new`         |                   |                          | Save first, then clear history and unbind. Does not delete the old file. Save `error`/`stale` **aborts**: `Current session could not be saved; the new conversation was not started.`                                 |
| `/telemetry`   |                   |                          | Lifetime local reliability counters per model                                                                                                                                                                         |
| `/exit`        | `/quit`           |                          | Shutdown                                                                                                                                                                                                              |

`Ctrl+Y` while a turn, command, transition, or approval is active: `Permission mode is locked while a turn or command is running.` `/permissions` cannot be submitted in that state (the prompt is ignored). Palette cannot open during a run.

`/model` without any backend: `Failed to fetch models — …` (or `is the backend running?`). A missing MLX worker still lists Ollama models plus a warning line.

After abort, the transcript adds `Generation interrupted`. History keeps streamed assistant text; if only reasoning arrived, the stored assistant content is `(interrupted)`; if nothing streamed, history is unchanged.

`/verify` self-check lines: `✓ self-check passed — N edit(s) reviewed`, `⚠ self-check flagged N edit(s): …`, or `self-check inconclusive`. FAIL may append ` — asking the model to fix it`.

---

## Advertised keybindings

From `src/tui/input/keybindings.ts` (same list as `/help`):

| Keys                  | Action                                                         |
| --------------------- | -------------------------------------------------------------- |
| `Ctrl+P`              | Command palette                                                |
| `Ctrl+Y`              | Toggle ask / yolo                                              |
| `Ctrl+T`              | Toggle **visibility** of streamed reasoning (not `--no-think`) |
| `Ctrl+C`              | Interrupt a run, or exit when idle                             |
| `Esc`                 | Interrupt a run, or exit when idle                             |
| `↑` / `↓`             | Prompt input history (when the completion menu is closed)      |
| `PageUp` / `PageDown` | Page the transcript                                            |

`Ctrl+T` vs `--no-think`: the flag disables reasoning **requests**. The key only hides or shows thinking already (or still) being streamed.

Palette Enter runs keybindings that declare an `action` (`toggle-thinking`, `toggle-permissions`). `Ctrl+P` / paging / interrupt keys are advertised but not palette-runnable.

---

## Prompt editing (not in `/help`)

Emacs-style editing on the prompt line (`src/tui/prompt/prompt-edit.ts`):

| Keys                                           | Effect               |
| ---------------------------------------------- | -------------------- |
| `Ctrl+A` / Home                                | Start of line        |
| `Ctrl+E` / End                                 | End of line          |
| `Ctrl+B` / Left                                | Grapheme left        |
| `Ctrl+F` / Right                               | Grapheme right       |
| `Ctrl/Meta+Left`                               | Previous word        |
| `Ctrl/Meta+Right`                              | Next word            |
| `Ctrl+U`                                       | Delete to line start |
| `Ctrl+K`                                       | Delete to line end   |
| `Ctrl+W` / `Ctrl+Backspace` / `Meta+Backspace` | Delete word before   |
| `Ctrl+D`                                       | Delete forward       |
| `Ctrl+Delete` / `Meta+Delete`                  | Delete to line end   |
| `Meta+D`                                       | Delete word after    |
| Backspace / `Ctrl+H`                           | Delete backward      |
| Delete                                         | Delete forward       |

Mouse wheel over the prompt scrolls the transcript by 3 lines.

---

## `@` mentions and `/` completion

- `/` + a word completes slash commands **and** discovered skill names (max 8 rows). `/sim` completes `simplification-review`.
- `@` completes project files from a session-owned catalog (text-like paths, up to 5,000 files, **max 8 rows**). Refresh happens when you type an `@` query.
- Mentions: `@path` or `@"quoted path"` after start-of-line or whitespace.
- On submit, mentioned files are attached in order, fitted to the request budget. Skip reasons: `not found`, `too large`, `binary`, `unreadable`, `outside workspace`, `over budget`. Caps include 64 files and a 1 MiB text read limit per file.

Completion menu: Up/Down select; Tab/Enter accept; Esc dismisses the **menu** (does not abort a run).

Placeholder when idle: `ask coral anything`.

Input history is `CORAL_HOME/history.jsonl` (default `~/.coral/history.jsonl`), mode `0o600`. Navigation loads the newest **500** valid rows. The file is append-only and is not compacted on read, so it can grow past 500. Slash commands and chat prompts are both recorded. Consecutive identical text is deduped.

---

## Model picker

Chrome: `Select a model`; `enter selects · ↑↓ or j/k moves · esc quits`. Rows show `name  (ollama|mlx)`.

- Up/`k`, Down/`j`, Enter select, Esc cancel (no Agent yet → quit; after an Agent exists → `esc returns to chat`).
- After an error: `r` / `R` retry.
- Empty: `No models found` / `Pull an Ollama model, add mlx: weights, or pass --model.`

Preferred pin: `gemma4:31b-mlx` (Ollama tag).

---

## Command palette

`Ctrl+P`. Header `command palette ctrl+p`. Filter by typing. Enter runs a command or a palette-bound action. Esc / `Ctrl+C` / `Ctrl+P` close. Empty filter result: `no matches`. Discovered skills appear as `/name` entries; selecting one starts a skill turn.

---

## Approval boxes

Gated tool calls, MCP launch trust, and doom-loop pauses open a modal. If the body is taller than the terminal, it scrolls: `↑`/`↓` one line, `PgUp`/`PgDn` one page. Title and action keys stay pinned. Diff previews cap at 20 lines.

| Kind       | Title / actions                                                                         | Keys                                                                                |
| ---------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Tool       | `Allow {tool}?` · `(y) approve  (n) reject  (esc) cancel`                               | `y` approve; `n` or Esc reject; `Ctrl+C` abort the run                              |
| MCP launch | `Trust & launch MCP server "{alias}"?` · `(y) trust & launch  (n) reject  (esc) cancel` | `y` trust; `n` reject; **Esc and Ctrl+C abort the run** (Esc is not a clean reject) |
| Doom loop  | `(y) continue  (n) stop`                                                                | `y` continue; `n` or Esc stop; `Ctrl+C` abort                                       |

Yolo auto-approves `require_approval` **tool** calls (including outside-workspace promotions). Yolo **never** auto-approves MCP launch trust.

---

## Themes

| Id            | Label       | Description                                     |
| ------------- | ----------- | ----------------------------------------------- |
| `coral-reef`  | Coral Reef  | warm coral & ocean teal (default)               |
| `deep-sea`    | Deep Sea    | bioluminescent cyan & violet for dark terminals |
| `sunset-tide` | Sunset Tide | warm coral, pink & amber                        |
| `kelp-forest` | Kelp Forest | greens, teals & earthy sand                     |
| `tide-pool`   | Tide Pool   | soft pastel pinks, teals & lavender             |
| `adaptive`    | Adaptive    | inherits your terminal's ANSI palette           |

CLI `--theme` applies for this process. `/theme` saves `theme` in `CORAL_HOME/prefs.json`.

---

## Shutdown

Idle `Esc` / `Ctrl+C`, `/exit`, `/quit`, SIGINT, and SIGTERM go through the shutdown coordinator: cleanup (Agent dispose, telemetry flush when a turn was produced), then Ink exit. `exitOnCtrlC` is disabled so Coral owns interrupt vs exit.

---

## Related

[CLI](cli.md) · [Permissions](permissions.md) · [Sessions](sessions.md) · [Context](context.md) · [Architecture](architecture.md) · [Troubleshooting](troubleshooting.md)
