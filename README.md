# Coral

Coral is a local-first CLI/TUI coding agent powered by Ollama. It can inspect a
codebase, search by text or meaning, edit files, run commands, work with Git,
delegate read-only research, and preserve multi-turn sessions from a terminal.

Coral has no cloud inference API or remote telemetry. Model requests go only to
the Ollama host you configure (`http://localhost:11434` by default), and Coral's
reliability telemetry stays in local files under `CORAL_HOME`. Optional MCP
servers are separate subprocesses that you explicitly configure and trust; they
may access local files, the host, or remote services according to their own
behavior.

> Coral is pre-1.0 and built for capable local models. Interfaces, session data,
> and configuration may still change between minor releases.

## Requirements

- Node.js 24 or newer
- A running [Ollama](https://ollama.com/) server
- At least one model already pulled into Ollama
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for the `grep` and
  `glob` tools
- Optional: the executable or container runtime required by any MCP server you
  configure
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

| Option                  | Behavior                                                                  |
| ----------------------- | ------------------------------------------------------------------------- |
| `-V`, `--version`       | Print the Coral version                                                   |
| `-m`, `--model <model>` | Use an installed Ollama model without opening the picker                  |
| `--host <url>`          | Set the Ollama host; defaults to `http://localhost:11434`                 |
| `--no-think`            | Disable streamed reasoning requests                                       |
| `--yolo`                | Auto-approve gated calls; `always_deny` stays blocked; MCP is unavailable |
| `--resume`              | Resume the most recent usable session                                     |
| `--session <id>`        | Resume one exact session ID                                               |
| `--sessions`            | List saved sessions and exit                                              |
| `--theme <name>`        | Select a color theme; `/theme` lists available names                      |
| `-h`, `--help`          | Show CLI help                                                             |

## Interactive use

- Type a normal prompt to start an agent turn.
- Type `/` to autocomplete slash commands.
- Type `@` to pick a project file. Mentioned text files are attached to that
  turn within a bounded context budget.
- Press `Ctrl+P` to search commands and keybindings in the command palette.
- Approval boxes show pending write/edit diffs when a preview is available.
- The first launch of each MCP server shows its full launch identity in a
  separate trust prompt before Coral starts the process.
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
| `/mcp`                                         | Show MCP config, launch, server, and available-tool status           |
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
- Trusted, explicitly allowlisted MCP tools from local stdio server processes;
  MCP tools are namespaced as `mcp__<server>__<tool>`, executed serially, and
  admitted within the active model's context budget, and never exposed to
  read-only subagents

`code_intel` starts its bundled TypeScript language server only on first use,
shares it with read-only subagents, and shuts it down when Coral disposes the
owning Agent. It supports `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`,
and `.cjs`. Other languages, code actions, rename/refactor operations, and
workspace-wide diagnostics are not part of the current MVP.

## Permissions and safety

The default policy auto-allows read/search/code-intelligence operations and
requires approval for file mutations, shell commands, Git mutations, and every
MCP tool. Project and user configuration can set any tool to:

- `always_allow`
- `require_approval`
- `always_deny`

`yolo` skips prompts for approval-gated built-in calls; it does not override
`always_deny`. MCP is unavailable in yolo mode in v0.13. Switching back to ask
mode creates a fresh MCP manager, and configured servers start on the next chat
turn.

MCP launch trust and MCP tool approval are different gates. Launch trust
authorizes one exact process identity before spawn; normal tool policy then
decides whether each namespaced tool call is allowed, prompted, or denied. A
user may set a tool such as `mcp__github__get_me` to `always_allow` in
`~/.coral.json`, while project configuration may only tighten that decision.

Approval prompts that exceed the terminal height scroll inside a bounded
viewport: `↑`/`↓` move one line, `PgUp`/`PgDn` move one page, and a position
indicator shows where you are. The title and action keys stay pinned, so the
complete launch identity remains inspectable before trusting a server.

Neither `bash` nor MCP server processes are sandboxed. They run directly on the
host and may access the network or files outside the project. MCP reduces
ambient authority by launching without a shell, using the home directory as a
neutral working directory, forwarding only a minimal process environment plus
named variables, exposing only exact allowlisted tools, and refusing launch
when every configured tool is denied. These controls do not make an untrusted
server safe.

File, search, and code-intelligence tools request separate approval for explicit
paths outside the active workspace even when their normal policy is
`always_allow`. Symlink paths that escape the workspace fail closed.

Undo/redo verifies that the current file still matches Coral's recorded state
before changing it. Session snapshots used by undo can duplicate edited file
contents, including secrets, under `~/.coral/sessions/` (or `CORAL_HOME`). Treat
that directory with the same care as the workspace.

## Configuration

Coral reads JSON configuration from two places:

- `~/.coral.json`: user-level permission defaults and MCP server definitions
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

### Local MCP servers

Coral's v0.13 MCP client supports local stdio servers that expose tools. Server
definitions are accepted only from the user-owned `~/.coral.json`; a cloned
project cannot add a process launch through `<workspace>/.coral.json`.

```json
{
  "mcp": {
    "servers": {
      "github": {
        "command": "docker",
        "args": [
          "run",
          "-i",
          "--rm",
          "-e",
          "GITHUB_PERSONAL_ACCESS_TOKEN",
          "-e",
          "GITHUB_READ_ONLY",
          "-e",
          "GITHUB_TOOLS",
          "ghcr.io/github/github-mcp-server"
        ],
        "enabledTools": ["get_me", "get_file_contents", "pull_request_read"],
        "passEnv": [
          "GITHUB_PERSONAL_ACCESS_TOKEN",
          "GITHUB_READ_ONLY",
          "GITHUB_TOOLS"
        ],
        "startupTimeoutMs": 30000,
        "toolTimeoutMs": 60000
      }
    }
  },
  "permissions": {
    "mcp__github__get_me": "always_allow"
  }
}
```

Set the values in the environment that starts Coral; do not put secret values
in the JSON file:

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN="$(gh auth token)"
export GITHUB_READ_ONLY=1
export GITHUB_TOOLS=get_me,get_file_contents,pull_request_read
npm run dev
```

This example uses the official
[GitHub MCP Server](https://github.com/github/github-mcp-server), restricts the
server itself to read-only mode and three tools, then applies Coral's own exact
three-tool allowlist. `always_allow` above is optional; without it, each MCP
tool call requires approval. Pin the container image by digest when immutable
server code is important to your threat model.

Server fields:

| Field              | Contract                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`          | Required executable name resolved through `PATH`, or an absolute path; never passed through a shell; Windows accepts native `.exe`/`.com` only |
| `args`             | Ordered argument array; defaults to `[]`; maximum 64 items                                                                                     |
| `enabledTools`     | Required exact names using 1–128 letters, digits, `_`, or `-`; wildcards are rejected                                                          |
| `passEnv`          | Environment-variable names to forward; values are read at launch and never shown by `/mcp`                                                     |
| `startupTimeoutMs` | Total server startup/discovery timeout; default 10,000; allowed range 1,000–60,000                                                             |
| `toolTimeoutMs`    | Per-call timeout; default 60,000; allowed range 1,000–600,000                                                                                  |

Configuration is limited to four servers and twelve enabled tools total. Alias
names must start with a lowercase letter or digit and contain only lowercase
letters, digits, `_`, or `-`. If any environment variable named in `passEnv` is
unset, Coral disables that server for the session rather than launching it with
an incomplete environment. Coral also skips discovered definitions that would
push the complete tool payload beyond the active model's context-relative
budget; `/mcp` reports the skipped tool. Changes to server configuration,
context size, model, or discovered tools require a fresh manager or session.

On first use, Coral resolves the executable to its real path and asks you to
approve the alias, configured command, resolved executable, complete ordered
arguments, neutral home-directory working directory, environment names,
enabled tools, and SHA-256 launch fingerprint. Approval is stored in
`CORAL_HOME/mcp-trust.json`. Any fingerprinted configuration or executable-path
change requires approval again. The fingerprint does not hash executable
contents or resolve a mutable container tag, so an update at the same path or
tag does not trigger reapproval.

Launch approval is requested sequentially in configuration order. After all
required approvals finish, Coral starts at most two approved servers at once,
then installs their tools in configuration order so collisions, budgets, and
model-visible ordering remain deterministic.

MCP stdio messages are newline-delimited and limited to 16 MiB or 8,192 retained
fragments per unfinished message. Supported tool result content is sanitized and
redacted incrementally; Coral retains at most a 100,000-character result body
before appending an explicit omitted-character marker. A server that exceeds a
protocol-message limit is stopped and shown as failed in `/mcp`.

Use `/mcp` at any time to inspect configuration errors and each server's state,
resolved executable, working directory, forwarded environment names, enabled or
available tools, and bounded diagnostic text. The command is observational and
never launches a server. Common states:

- `configured`: valid config has not started yet; send a chat turn in ask mode
- `needs_trust`: the launch needs interactive trust; restart in the TUI if the
  current caller could not prompt
- `blocked`: effective permissions deny every configured tool, so Coral did not
  start the process
- `failed`: inspect the bounded detail/stderr for a missing executable, missing
  environment variable, Docker daemon failure, timeout, protocol error, or
  allowlisted tool the server did not expose
- `rejected`: launch trust was declined for this session
- `stopped`: an interrupted/timed-out call retired the server; restart Coral to
  use it again
- `ready`: discovery succeeded and the listed namespaced tools are available

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
| `~/.coral/mcp-trust.json`         | Approved MCP launch fingerprints                                 |

`CORAL_HOME` relocates every path in this table. The separate read-only user
configuration remains `~/.coral.json`.

Coral does not upload these files or emit remote telemetry. If you set `--host`
to a non-local Ollama server, prompts, attached files, tool results, and
conversation context are sent to that configured server. If you enable MCP,
Coral sends model-generated MCP arguments to the trusted subprocess and returns
its results to the model, so any remote service used by that subprocess becomes
an additional data boundary.

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
- MCP v0.13 supports local stdio tool servers in ask mode only. Remote transports,
  OAuth, standalone resource discovery/reads, prompts, sampling, elicitation,
  hot config/tool-list updates, MCP use from subagents, and parallel MCP calls
  are deferred. Text resources embedded directly in a tool result are supported.
- MCP processes are not sandboxed. Coral bounds each newline-delimited stdio
  protocol message, but a trusted server can still consume host resources in
  its own process; use only servers you trust.
- Semantic search uses an in-process vector scan and is intended for ordinary
  project sizes, not giant monorepos.
- The project does not currently declare a software license.
