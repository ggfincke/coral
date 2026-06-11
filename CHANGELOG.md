# Changelog

All notable changes to Coral are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Tool-call reliability layer:** recover tool calls emitted as text content
  (the most common local-model failure), canonicalize hallucinated tool-name
  variants (`Read_File` -> `read_file`), nudge fully empty turns (capped at 2
  per run), validate & coerce tool args against each tool's JSON schema before
  execution w/ model-friendly retry errors, & surface repair/nudge/validation
  counters in `/status`.
- `format` field on `ChatRequest` for tool-free structured-output calls.
  Never combined w/ `tools` — Ollama silently drops tool calls when both are
  set (ollama/ollama#8095), so constrained decoding of tool calls is not
  viable upstream.

### Changed

- Tool dispatch now resolves tools from the agent's own toolset instead of the
  global registry, so restricted toolsets (e.g. read-only subagents) can no
  longer reach tools outside their subset.t

## [0.10.0] - 2026-06-11

### Added

- **GitHub PR workflow & CI:** add Actions coverage for clean install, audit,
  lint, formatting, changelog validation, typecheck, tests, & build.
- **Repo automation templates:** add Dependabot config, PR checklist, bug report
  template, & feature request template.
- **Changelog gate:** add `npm run check:changelog` plus an `npm version`
  guard so releases require a matching changelog entry.
- **Slash command control surface:** add abort support, slash commands, git
  tools, token tracking, in-place model switching, permission toggles, & context
  gauge polish (`394f0ce`, `254801c`).
- **Input history & two-phase compaction:** add prompt history navigation,
  richer session restoration, & safer conversation compaction controls
  (`92aa2b1`, `a29a863`).
- **Parallel agent execution:** run safe tool calls in parallel & normalize tool
  output handling in the agent loop (`809d352`).
- **Research subagents & todos:** add read-only task delegation and structured
  task tracking with a TUI todo panel (`a5fc925`, `50caa78`).
- **Dynamic TUI themes:** add a theme system, built-in theme palette, and
  persisted theme preferences (`1865677`, `0c5555d`).
- **Git commit workflow support:** add `git_push`, richer git tool definitions,
  and commit-workflow prompt guidance (`1a2d10f`, `b2c60a8`).
- **Shared project utilities:** add reusable project-tree, Coral home, and git
  helpers for tool and session features (`f410517`).
- **Repository setup:** initial project infrastructure and CI configuration (`1e4817e`).

### Changed

- Refactored the TUI into smaller command, transcript, input-history, approval,
  metrics, status-line, and restoration modules (`438cdf4`).
- Moved shared inference types and updated the Ollama client/session store
  boundary for the newer agent loop (`9e4122f`).
- Updated the test suite and test philosophy docs to match the current core,
  tool, session, TUI, theme, and compaction behavior (`0de32d7`).

### Fixed

- Allow safe agent planning tools by default so planning helpers do not trip the
  approval policy (`68fceac`).

## [0.9.0] - 2026-04-05

### Added

- **Session persistence** — save & resume conversations to disk as JSON in `~/.coral/sessions/` (`be8b243`)
  - 8-character hex session IDs w/ metadata (model, cwd, title, timestamps, message count)
  - Auto-generated session titles from first user message (truncated to 80 chars)
  - CLI flags: `--resume` (latest session), `--session <id>` (specific session), `--sessions` (list all)
  - Auto-save on every turn completion (both success & error) to preserve partial progress
  - Session restoration rebuilds TUI output blocks from saved message history
  - Auto-selects the original model when resuming a session
- **Context injection at startup** — auto-load project files into the system prompt (`be8b243`)
  - 17 file types scanned in priority order (`.coral.md`, `README.md`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.)
  - Project type detection: Node.js, Python, Rust, Go, Ruby, Java/JVM
  - Directory tree builder (2 levels deep, 25 entries/level, filters noise dirs)
  - Budget management: 16K total chars, 8K per file, with truncation markers
- **Conversation compaction** — summarize old turns to stay within context limits (`be8b243`)
  - Token estimation heuristic (chars / 4) w/ configurable thresholds
  - Splits at user message boundaries to avoid breaking mid-turn
  - Model-based summarization: older messages replaced w/ a condensed summary
  - Non-fatal — continues with uncompacted history if summarization fails
  - Configurable via `CompactionConfig` (contextWindow, minRecentMessages, minMessagesForCompaction)
- **Configurable tool permissions** — per-tool policies via `.coral.json` config files (`be8b243`)
  - Three-level merge: built-in defaults -> user `~/.coral.json` -> project `.coral.json`
  - Three policies: `always_allow`, `require_approval`, `always_deny`
  - Sensible defaults: read/search tools auto-allow, write/edit/bash require approval
  - Unknown tools default to `require_approval`; invalid config values silently ignored
- Tests for session persistence (10), context injection (11), conversation compaction (12), tool permissions (6), Ollama client (2), & agent permission enforcement (`be8b243`)

### Changed

- Agent tool dispatch now uses policy-based permission checks instead of a hardcoded approval set (`be8b243`)
- Agent exposes `restoreMessages()`, `getMessages()`, `getModel()`, & `setCompactionConfig()` for session & compaction support (`be8b243`)
- Compaction check runs at the start of every agent loop iteration (`be8b243`)
- System prompt appends gathered project context when available (`be8b243`)
- `chatStream` refactored to use `ReadableStream` instead of ndjson line splitting (`be8b243`)

## [0.8.0] - 2026-04-05

### Added

- **Model picker at startup** — query Ollama for available models & present interactive selection when no `-m` flag is passed (`34766ce`)
  - Shows model name, size, & last modified date
  - Arrow keys + j/k for navigation, Enter to select, Escape to quit
  - Auto-selects if only 1 model available
  - Error state with 'r' to retry if Ollama is unreachable
  - Pagination for long model lists
- **Scrollable output** — viewport w/ scroll when conversation exceeds terminal height (`34766ce`)
  - Terminal resize tracking, dynamic viewport height calculation
  - PageUp/PageDown & arrow keys (when input empty) for scrolling
  - Auto-scroll on new content unless user has scrolled back
  - Status line shows "scrollback active" when scrolled
- **Markdown rendering** — rich terminal output for model responses (`34766ce`)
  - Headings h1-h6 with colors & underlines for h1/h2
  - Bold, italic, strikethrough, inline code spans
  - Code blocks with syntax highlighting via `cli-highlight` (language-aware + auto-detect fallback)
  - Ordered/unordered/task lists with proper indentation
  - Tables with box-drawing characters & column alignment
  - Blockquotes, links, horizontal rules
  - Applied to both completed & streaming assistant output
- **Streaming display improvements** — word-wrap, visual separation, & syntax highlighting in streamed output (`34766ce`)
  - ANSI-aware word wrapping to terminal width via `wrap-ansi`
  - Visual separation: blank lines between turns, colored headers per role (green "You", cyan "Coral", dim "Tool", red "Error")
  - Token batching with 32ms flush interval for smooth rendering
- **Test suite** — 8 tests covering agent loop, system prompt, tools, TUI rendering, & model picker (`34766ce`)

### Changed

- TUI rewritten with state-machine architecture: model picker -> agent conversation -> scrollable viewport (`34766ce`)
- Agent streams now accumulate thinking content & merge tool call chunks into stable ordered lists (`34766ce`)
- System prompt includes lightweight project root file listing for model awareness (`34766ce`)
- Ollama client exposes `listModels()` querying `/api/tags` (`34766ce`)

### Added (dependencies)

- `chalk` ^5.6.2, `cli-highlight` ^2.1.11, `marked` ^17.0.6, `strip-ansi` ^7.2.0, `wrap-ansi` ^10.0.0 (`34766ce`)

## [0.7.0] - 2026-04-05

### Added

- **Tool approval UX** — y/n confirmation prompt before executing dangerous tools (`845d6f9`)
  - Async `onToolApproval` callback in agent events interface
  - TUI renders approval prompt: shows tool name & formatted args (command for bash, path for write/edit)
  - Y/y to approve, N/n or Escape to reject
  - Rejection recorded as tool result so the model knows the call was denied
- **Keep-alive for loaded models** — prevent Ollama from unloading the model mid-session (`845d6f9`)
  - Periodic keep-alive pings while the agent is active
  - `chatStream` sends `keep_alive: "10m"` by default
  - `Agent.dispose()` stops keep-alive & unloads model on exit

### Changed

- Agent tool dispatch checks an approval set & calls `onToolApproval` before executing write/edit/bash (`845d6f9`)
- TUI handles approval state, keyboard input for y/n, & prompt rendering (`845d6f9`)
- Ollama client sends `keep_alive` field with chat requests (`845d6f9`)

## [0.6.0] - 2026-04-03

### Added

- **Centralized CWD module** — single source of truth for working directory (`5d929ab`)
  - `getCwd()`, `setCwd()`, `resolvePath()` — resolves relative paths against CWD, passes absolute paths through
  - All 7 tools now resolve paths via `resolvePath()`
  - `bash` tool executes child processes in the correct working directory
  - Agent constructor initializes CWD from provided path or `process.cwd()`

### Changed

- Every tool file updated to use centralized path resolution instead of ad-hoc logic (`5d929ab`)

## [0.5.1] - 2026-04-03

### Changed

- **Consolidated shared utilities** — extracted common patterns into reusable modules (`0096d5a`)
  - `readFileGuarded()` with 1MB size guard & typed result union
  - Shared ripgrep runner with timeout (15s), buffer limit (5MB), & proper error handling
  - `truncateOutput()` for consistent result limiting across tools
  - Tools refactored to use shared utils: read_file, edit_file, grep, glob, list_files
- Improved streaming display with better turn separation & status indicators (`0096d5a`)
- Improved Ollama stream parsing robustness & error handling (`0096d5a`)
- Cleaner agent tool dispatch loop with better error messages (`0096d5a`)

### Fixed

- `--host` CLI flag now correctly passed to Ollama client (`0096d5a`)

## [0.5.0] - 2026-04-03

### Added

- **List files tool** — directory tree listing w/ configurable recursion depth (`1bee633`)
  - `path` & `depth` parameters (depth clamped to 1-5, default 2)
  - Tree-formatted output with indentation, `/` suffix for dirs, `@` for symlinks
  - Ignores noise directories: .git, node_modules, .next, .cache, dist, build, **pycache**, .venv, target, .DS_Store
  - 200-entry limit with truncation message

## [0.4.0] - 2026-04-03

### Added

- **Grep tool** — search file contents by regex pattern, backed by ripgrep (`74b7dac`)
  - Parameters: `pattern` (regex), `path` (directory scope), `include` (file type glob filter)
  - Returns matching lines with file paths & line numbers
  - 200-match result limit with truncation
- **Glob tool** — find files by name pattern, backed by ripgrep (`74b7dac`)
  - Parameters: `pattern` (glob, e.g. `**/*.ts`), `path` (search root)
  - Results sorted by modification time (newest first)
  - 100-file result limit with truncation

## [0.3.0] - 2026-04-03

### Added

- **Edit tool** — surgical find/replace file editing (`6c3f8f7`)
  - `path`, `old_string`, `new_string`, `replace_all` parameters
  - Fails if `old_string` not found in file
  - Fails if `old_string` matches multiple locations (unless `replace_all: true`)
  - Reports file path, replacement count, & character delta on success

### Changed

- System prompt flattened — removed nested sections, more direct behavioral rules (`6c3f8f7`)

## [0.2.0] - 2026-04-03

### Added

- **System prompt** — model identity, tool awareness, & behavioral guidelines (`39eac65`)
  - Context-aware system message injected at conversation start
  - Tells model what it is, lists available tools w/ parameter schemas, injects working directory
  - Two-tier system: full prompt for large models (31B+), compact variant for small models
  - Behavioral guidelines: conciseness, tool verification, relative paths, error handling

### Changed

- Agent injects system prompt as first message in conversation history (`39eac65`)

## [0.1.1] - 2026-04-03

### Added

- Test philosophy documentation (`8a34d6c`)

## [0.1.0] - 2026-04-03

### Added

- **Initial scaffold** — CLI/TUI coding agent for Ollama (`6326d14`)
  - Ollama REST client wrapping `/api/chat` with ndjson streaming
  - Agent conversation loop with tool-use cycling — streams response, detects tool calls, executes, feeds results back, loops until done
  - React Ink TUI — conversation display, user input, streaming token rendering
  - CLI entry point with commander — `-m` model flag, `--host` Ollama URL
  - Tool interface & registry with `toolToOllamaFormat()` converter
  - `read_file` tool — read file contents by path
  - `write_file` tool — create/overwrite files with content
  - `bash` tool — execute shell commands with timeout (30s default)
  - ESM throughout with `NodeNext` module resolution

[0.10.0]: https://github.com/user/coral/compare/be8b243...1e4817e
[0.9.0]: https://github.com/user/coral/compare/34766ce...be8b243
[0.8.0]: https://github.com/user/coral/compare/845d6f9...34766ce
[0.7.0]: https://github.com/user/coral/compare/5d929ab...845d6f9
[0.6.0]: https://github.com/user/coral/compare/0096d5a...5d929ab
[0.5.1]: https://github.com/user/coral/compare/1bee633...0096d5a
[0.5.0]: https://github.com/user/coral/compare/74b7dac...1bee633
[0.4.0]: https://github.com/user/coral/compare/6c3f8f7...74b7dac
[0.3.0]: https://github.com/user/coral/compare/39eac65...6c3f8f7
[0.2.0]: https://github.com/user/coral/compare/8a34d6c...39eac65
[0.1.1]: https://github.com/user/coral/compare/6326d14...8a34d6c
[0.1.0]: https://github.com/user/coral/releases/tag/6326d14
