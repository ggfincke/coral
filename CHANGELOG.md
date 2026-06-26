# Changelog

All notable changes to Coral are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Per-model reliability telemetry persists across sessions:** the
  reliability-layer counters (`/status` "Repairs" line) are now folded into
  `~/.coral/telemetry.json`, keyed by model, when an agent is disposed — so a
  model's lifetime tool-call repairs, edit fixes, reprompts, doom-loop trips,
  and verify flags accumulate across sessions instead of resetting each run.
  The fold happens once per agent lifetime and only after the model has
  produced a turn, so picker churn doesn't inflate the counts. A new
  `/telemetry` command prints the per-model lifetime totals. This makes v0.11.0
  the baseline epoch for tracking whether a model gets more or less reliable
  over time.
- **Eval harness `--save-telemetry`:** running the eval harness with
  `--save-telemetry` now sums each model's reliability counters across every rep
  and task into one entry and folds it into `~/.coral/eval-telemetry.json`, so
  benchmark reliability becomes longitudinal across runs instead of dying with
  the process. The eval store is kept separate from the interactive
  `~/.coral/telemetry.json` that `/telemetry` reads, so synthetic benchmark
  counters never swamp the real-usage signal. After a saving run the cumulative
  lifetime view prints below the per-run report (suppressed under `--json`).
- **Cap model-facing error text:** the text fed back to the model on a tool
  failure is now bounded the same way tool output already was. An oversized
  error string (e.g. a multi-KB stack trace) is truncated in the model history,
  and the pre-dispatch validator now shows the first eight argument problems
  plus a "plus N more" summary instead of an unbounded list — keeping the
  trailing fix instruction intact. This stops a weak local model from stalling
  or hallucinating on feedback larger than its own request. The full error still
  reaches the UI; only the model's history copy is capped.

### Changed

- **Semantic index & `@`-mentions now respect `.gitignore`:** project file
  discovery prefers `git ls-files --cached --others --exclude-standard`, so
  git-ignored files no longer land in the semantic index or the `@`-mention
  picker (previously a raw filesystem walk indexed them). Outside a git repo it
  falls back to the ignore-aware filesystem walk.
- **Project `.coral.json` permissions are tighten-only:** a project-level
  permission config can now only make a tool's policy stricter than the
  user/default policy, never looser. A repo can tighten `always_allow` to
  `require_approval`/`always_deny`, but a project asking for `always_allow` on a
  tool the user left at `require_approval` is ignored — so cloning an untrusted
  repo can't silently widen what its config auto-approves.

### Fixed

- **Per-turn latency on large sliding-window contexts:** a single model call
  could stall for tens of minutes deep into a long session. Two causes, both
  fixed. First, the generate path sent no token ceiling, so a runaway reasoner
  could decode thinking until it filled the entire window — requests now send a
  bounded `num_predict` (a tighter ceiling for the one-shot compaction summary).
  Second, compaction triggered at a fraction of the pinned `num_ctx`, so on a
  model pinned to a very large native window (e.g. `gemma4` at 262144) the live
  context was allowed to grow toward ~196k tokens before compacting — and a
  sliding-window model on the MLX engine re-prefills the whole prompt every turn
  with no KV-cache reuse, so each turn paid a full prefill of that context.
  Compaction now targets a fixed working-set budget (`MAX_WORKING_SET_TOKENS`,
  32k) decoupled from `num_ctx`, keeping the re-prefilled context small while the
  window stays maxed. Together these bound both the decode and prefill cost of a
  single turn.

## [0.11.0] - 2026-06-21

### Added

- **Whitespace-tolerant `edit_file`:** when `old_string` doesn't match the file
  verbatim, `edit_file` now falls back to a block match that ignores
  per-line indentation, trailing whitespace, and CRLF/LF drift — the single
  most common way a small local model botches an edit. The replacement is
  re-indented onto the file's own indentation, so the fix lands correctly even
  when the model copied the wrong leading whitespace. The fallback refuses an
  ambiguous match (more than one normalized hit without `replace_all`) so a loose
  match can never edit the wrong block, and the approval-box preview reflects the
  fuzzy-resolved target (preview and execution share the same `applyEdit`, so
  they can't drift). A recovered edit is reported back to the model as matched on
  normalized whitespace (so it copies exact text next time) and counted in a new
  `edit-fix` reliability counter surfaced in `/status` (and the eval harness's
  compensation rate). On a genuine miss the error now points at where
  `old_string`'s first line does or doesn't appear in the file instead of a bare
  "not found".
- **Prompt completion + `@`-file mentions:** typing `/` opens a live
  command-autocomplete menu (prefix-ranked, Tab/Enter to accept, arrows to
  move, Esc to dismiss); typing `@` opens a fuzzy file picker over the
  ignore-aware project tree (binary files filtered out), with quoted-path
  support for names with spaces. Selecting an `@`-mention inserts the path and,
  on submit, pre-reads each mentioned file into the model's context (transcript
  still shows the clean prompt) so a small-context model gets the right code
  without burning its window on blind `grep`. Pre-reads are bounded by a shared
  budget (the same scale as one large tool result), so `@`-mentions can never
  overflow the window; files past the budget are head-truncated or skipped, and
  any truncated/skipped/missing/binary mention is reported in a one-line
  transcript note instead of vanishing silently. Pure completion logic lives in
  `src/tui/completion.ts` and mention parsing/expansion in `src/tui/mentions.ts`,
  both unit-tested.
- **Todo session persistence + `/todo`:** the task list now persists with the
  session, so `/resume` restores it (and re-renders the panel) instead of
  dropping it. Adds a `/todo` command (view the list, `/todo clear` to clear &
  flush) and strikethrough styling for completed items in the live panel.
- **`/index` command:** build or refresh the semantic code index on demand
  (`/index`, or `/index rebuild` to force a full re-embed) with throttled
  first-build progress in the transcript, instead of waiting for the first
  `search_code` to index lazily. A re-entrancy guard blocks overlapping builds.
- **`/status` frozen-prefix coverage:** `/status` now reports how much of the
  context Coral keeps byte-stable across compaction (frozen prefix tokens, % of
  the pinned window, & summary-block count) once compaction has run. Honest
  bookkeeping only — SWA/MLX models (default Gemma) re-prefill regardless, so
  it's labeled "kept stable", not a measured cache hit.
- **`/copy` command:** `/copy` copies the last assistant response to the system
  clipboard & `/copy code` copies its last fenced code block. Uses the platform's
  native clipboard CLI (`pbcopy` / `clip` / `wl-copy` / `xclip` / `xsel`) with no
  new dependency; extraction helpers live in `src/tui/copy.ts`.
- **Eval harness:** add a live-model benchmark (`npm run eval -- <model...>`)
  that drives a real Ollama model through 6 deterministic coding tasks
  (read-report, single-edit, create-file, search-multi-edit, build-run,
  bug-fix-verify) in throwaway temp dirs & reports per-model task completion,
  tool-call cleanliness (clean calls vs. reliability-layer compensations), &
  throughput — so model selection & reliability tuning become data-driven
  instead of vibes. Supports `--reps`, `--json`, repeatable `--task <id>`, &
  `--host`; see `tests/scripts/eval/README.md`.
- **Cache-friendly compaction:** compaction now keeps a byte-stable prefix
  (system prompt + append-only frozen summary blocks) and only ever summarizes,
  prunes, or trims the live tail, so llama.cpp reuses its KV cache through the
  prefix instead of re-prefilling the whole context after every compaction.
  Frozen summaries are appended, not re-summarized turn to turn, so there's no
  per-compaction summary-of-summary drift; only when they exceed a cap do they
  consolidate into a single block (and `/compact` always consolidates). Adds a
  `tests/scripts/bench-compaction.ts` harness
  (`npm run bench:compaction -- <model>`) that measures prefix reuse on a live
  model and flags SWA/MLX models where reuse is currently a no-op.
- **Pinned `num_ctx`:** the resolved context window is now sent as
  `options.num_ctx` on every request and held constant per session (inherited by
  subagents), so Ollama never reloads the runner mid-session — and the window is
  capped (default 32K, override via `.coral.json` `context.maxNumCtx` or
  `CORAL_NUM_CTX`) so compaction thresholds match what the server actually
  allocates instead of the model's architectural maximum.
- **Semantic code search MVP:** add a read-only `search_code` tool backed by
  local Ollama embeddings, deterministic source chunking, & a SQLite project
  index under Coral local state. The MVP lazily indexes the current project on
  first use, respects Coral's ignored-entry policy, defaults to
  `nomic-embed-text`, and exposes clean embedder/index-store seams for later
  vector extensions or alternate providers.
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
- **Diff display for file edits:** after `write_file`/`edit_file`, the
  transcript shows a colored unified diff (line-number gutter, 3 context
  lines, large diffs truncated w/ a summary marker) instead of the plain
  result line, & the approval box renders the exact pending change before
  authorization. New `diff` (jsdiff) dependency for diff generation.
- **Git workflow context:** inject a capped, volatile git snapshot into each
  model request so branch, upstream, operation state, staged/unstaged/untracked
  files, diff stats, & recent commits are visible without rewriting the stable
  system prompt. Adds approval-gated `git_switch` for structured branch
  switching/creation.

### Changed

- **Self-check now self-corrects:** when the post-edit verify pass returns a
  FAIL, the agent feeds the reason back to the model and gives it one bounded
  chance to fix the changes (`MAX_VERIFY_REPROMPTS`), instead of only warning
  and finishing. A fresh self-check reviews the fix on the next finish, so the
  surfaced verdict is always the final one; the reprompt asks the model to fix
  _or_ briefly justify, so a weak reviewer's false FAIL doesn't force a needless
  edit. Inconclusive verdicts still don't loop, the loop only runs when
  `/verify` is on, and `/status` reports a `verify-fix` counter. Closes the
  warn-only gap left by the verify MVP.
- Tool dispatch now resolves tools from the agent's own toolset instead of the
  global registry, so restricted toolsets (e.g. read-only subagents) can no
  longer reach tools outside their subset.
- Commit workflow guidance now treats untracked files as part of "current diff"
  unless narrowed, requires explicit path staging for grouped commits, and
  requires a status check before claiming commit work is complete.

### Fixed

- **Subagent abort threading:** the `task` tool now forwards the run's
  `AbortSignal` to the subagent runner, so `Escape` / `Ctrl+C` interrupts an
  in-flight subagent at its next round boundary instead of running until the
  `maxIterations` cap. The signal was already plumbed end-to-end everywhere
  except the `task` tool itself.
- `/diff` output now renders w/ proper git-diff coloring & a line-number
  gutter — its colors were previously clobbered by the system block's dim
  styling.

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

[0.11.0]: https://github.com/ggfincke/coral/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/ggfincke/coral/compare/be8b243...1e4817e
[0.9.0]: https://github.com/ggfincke/coral/compare/34766ce...be8b243
[0.8.0]: https://github.com/ggfincke/coral/compare/845d6f9...34766ce
[0.7.0]: https://github.com/ggfincke/coral/compare/5d929ab...845d6f9
[0.6.0]: https://github.com/ggfincke/coral/compare/0096d5a...5d929ab
[0.5.1]: https://github.com/ggfincke/coral/compare/1bee633...0096d5a
[0.5.0]: https://github.com/ggfincke/coral/compare/74b7dac...1bee633
[0.4.0]: https://github.com/ggfincke/coral/compare/6c3f8f7...74b7dac
[0.3.0]: https://github.com/ggfincke/coral/compare/39eac65...6c3f8f7
[0.2.0]: https://github.com/ggfincke/coral/compare/8a34d6c...39eac65
[0.1.1]: https://github.com/ggfincke/coral/compare/6326d14...8a34d6c
[0.1.0]: https://github.com/ggfincke/coral/releases/tag/6326d14
