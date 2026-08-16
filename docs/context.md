# Context, compaction, and undo

Coral pins one context window per Agent+model, keeps conversation history in `ConversationState`, and exposes `/compact`, automatic compaction, `/undo`, and `/redo`.

---

## Pinned context window

On first need (and again after `/model`), Coral chooses `num_ctx` and sends it as Ollama `options.num_ctx`. The value is stable for that Agent so the host does not reload the runner between turns. It is **not** saved in the session file. Subagents inherit the parent's pin.

### How the size is chosen

Constants in `src/config/context.ts`:

- Usable RAM: **75%** of `os.totalmem()`
- Reserve: **6 GiB** plus model weight bytes (from `/api/tags` `size`; missing → 0)
- Minimum window: **8,192** tokens
- Full-attention KV estimate: f16 (2 bytes/element) × layers × KV heads × (key + value length)
- Sliding-window architectures **`gemma` / `gemma2` / `gemma3` / `gemma4`**: treated as KV-light → pin **native** context after the weight check (no 1024 rounding from KV math)
- Full-attention: `floor(remainingBytes / kvBytesPerToken)`, clamp to native and minimum, round down to **1024**
- User ceiling: `CORAL_NUM_CTX` if it parses as an integer `> 0`, else project `context.maxNumCtx` (JSON **number** only)
- Final: `min(native, max(8192, min(memoryCap, ceiling)))`. If native is smaller than 8192, the pin is native.

If `showModel` fails or native length is `<= 0`, Coral falls back to **8192**. Compaction uses **32,768** as a conservative window when the live pin is still unknown.

`context.maxNumCtx` / `CORAL_NUM_CTX` are ceilings, not a promise you get that many tokens. A tiny override (for example 512) is still floored at 8192 unless native is smaller.

The pin is what Ollama allocates for KV. **Each request is then budgeted more tightly** (`src/agent/request/budget.ts`): response reserve ≈ 1/8 of the window (cap **16,384**, sent as `num_predict`); prompt limit = `window − reserve`, then capped at **32,768**. A large native pin does not mean Coral sends a 32k+ prompt. Attachments may use up to half of the remaining flexible budget, with a **4 MiB** aggregate capture cap.

`/status` shows estimated tokens (history + tool defs + framing) and, when Ollama has reported them, prompt/decode counts and average speeds.

---

## What competes for the window

Each model request is budgeted (`src/agent/request/budget.ts`): a response reserve (about 1/8 of the window, cap 16,384), then system prompt, tool schemas, history, volatile Git context, and `@` attachments, with the prompt itself capped at 32,768 tokens.

If it does not fit, `RequestPlanner` degrades in order: compact Git → drop Git → strip project files from the system prompt → compact history if allowed (hard-fit summarize between system and the active turn) → fit attachments. If protected history or fixed cost still overflow, `RequestBudgetError` (`onError`) distinguishes:

- `fixed_cost_overflow` — shorten the turn, disable optional MCP tools, or raise the context limit
- `history_overflow` — start a new session, compact earlier, or raise the context limit

Git context is a **request-only** extra system payload (`## Git Context`): branch, status lists (max 12 each), `--stat`, last 5 oneline commits, truncated at 6,000 characters. Not stored in history. Absent if cwd is not a git work tree.

`@` attachments: up to 64 files, 1 MiB text each, mention order, **4 MiB** aggregate capture, skip reasons `not found` | `too large` | `binary` | `unreadable` | `outside workspace` | `over budget`. The committed user message can include a `Referenced files (from @-mentions):` block; `displayContent` keeps your typed text for the UI.

---

## Automatic compaction

During `runInternal`, before a request:

1. **Prune** old tool results if there are at least **10** messages and estimated tokens exceed **75%** of the window. Newest **6** tool results are kept. Others become markers like `[tool result pruned — toolName: preview, ~N tokens]`. Prune does **not** clear undo. TUI: `Auto-pruned N old tool results (~… tokens freed)`.
2. **Summarize** if at least **20** messages and tokens exceed **90%**. Newest **10** messages stay verbatim. The summarizer is a tool-free Ollama call with a structured handoff prompt (Goal, Decisions, Work completed, Work remaining, Relevant files). Thinking is replaced with `[reasoning was used]`. TUI first line: `Context auto-compacted`, then `Undo history cleared`.
3. If summarization fails **2** times, Coral **trims** to the most recent **100** messages (`DEFAULT_MAX_HISTORY`). TUI: `Context trimmed to recent history (summarization unavailable)` plus `Undo history cleared`.
4. **Every** request iteration, if stored messages exceed 100, Coral also trims to 100 (preserving the active turn). That guard is independent of whether prune/summarize ran.

Automatic summaries freeze a user message starting with `[Conversation handoff`. At most **4** frozen summaries; extra ones are consolidated. Frozen prefix is Coral bookkeeping — sliding-window/MLX models may still re-prefill the prompt.

Summarize, trim, `/compact`, and `/clear` **clear undo/redo**. Prune does not. Run stage during a summarization call: `compacting context`.

---

## `/compact`

Manual summarize. The TUI refuses with `Conversation too short to compact` when **non-system** messages are fewer than 4 (`agent.getMessageCount() < 4`). `Agent.forceCompact` and `prepareSummary('manual')` refuse when **total** messages, including system, are fewer than 4. Progress: `Compacting conversation...`.

- Success: `Context compacted` and `Undo history cleared`; session saved
- Not enough to summarize: `Compaction skipped — not enough context to summarize`
- Interrupt: `Compaction interrupted`

Manual compact uses a frozen prefix of **system only** (then the new handoff), unlike automatic which can keep prior frozen summaries.

---

## `/undo` and `/redo`

Last **10** finalized turns can be undone. Each turn records the message slice, in-workspace file `before`/`after`, and optional todo snapshot.

Fail-closed file rules (`src/agent/effects/file-replay.ts`):

- Undo expects the file still equals recorded `after`; redo expects `before`
- Missing file: `Cannot {undo|redo} path: file is missing`
- Drift: `file changed outside Coral`
- Workspace/symlink failures as in [Permissions](permissions.md)
- Apply errors roll back already-written files; rollback failure is appended to the message

Other messages:

- `Nothing to undo` / `Nothing to redo`
- `Cannot undo after compaction or history changes` (same for redo)
- `Cannot undo after concurrent history changes` (stale revision; optional `; rollback failed: …`)
- Success: `Undid last turn` / `Redid last turn`

`/clear` drops history (keeps system) and clears undo/redo. Restore-from-session also clears live undo unless the file contained stacks.

Outside-workspace writes are not in the undo log.

---

## Request repairs that use context

- Empty model turn: up to **2** nudges — _Your last turn was empty…_
- Tool-shaped invalid text: **1** reprompt
- Doom loop: **3** identical calls or errors in a window of **12** → TUI continue/stop; exec stops
- `/verify on`: after edits, a read-only subagent must emit `VERDICT: PASS` or `VERDICT: FAIL`; one model retry on FAIL

`/status` `Repairs:` appears when **any** reliability counter is nonzero. Then `tool-call` (includes name repairs), `nudge`, and `invalid-args` always print (zeros included). `edit-fix`, `reprompt`, `loop`, `verify-flag`, and `verify-fix` print only when nonzero. `/telemetry` aggregates those counters **per model** across Agent lifetimes (local files only).

---

## Related

[Configuration](configuration.md) · [TUI](tui.md) · [Sessions](sessions.md) · [Architecture](architecture.md) · [Troubleshooting](troubleshooting.md)
