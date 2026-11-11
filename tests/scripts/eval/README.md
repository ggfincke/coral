# Coral eval harness

A small live-model benchmark for the local-model agent. It drives a real,
loaded Ollama model through a fixed set of coding tasks and measures, per model:

- **task completion** — did the agent actually produce the right result, graded
  deterministically (file contents, JSON fields, re-running the produced code)
  rather than by trusting the model's own claim.
- **tool-call success / cleanliness** — how much of the model's tool activity
  was a clean, valid call vs. a call the reliability layer had to repair, rename,
  nudge, validate-coerce, or re-prompt. Local models fail at tool invocation more
  than at reasoning, so this is the signal that makes model selection and
  reliability-layer tuning data-driven instead of vibes.

It also reports throughput (prompt/completion tokens, tokens/sec) and per-rep
reliability counters.

## The tasks

The suite (`tasks.ts`) seeds a throwaway scratch dir, runs the agent against a
prompt, then grades the result deterministically:

1. **read-report** — read the `port` out of a seeded `config.json` (w/ a
   distractor number in `notes.txt`) and report it in the final answer.
2. **single-edit** — bump the `version` field in a seeded `package.json` to
   `2.4.0` via an edit; graded by re-parsing the file.
3. **create-file** — create `greeting.txt` whose entire contents are exactly
   `hello world`.
4. **search-multi-edit** — rename `oldName` -> `newName` across two `.mjs` files
   including the import/call sites; graded by walking the tree for both names.
5. **build-run** — write `fizzbuzz.mjs` for 1..15 and run it; graded by
   re-executing the file ourselves and checking stdout against the expected lines.
6. **bug-fix-verify** — fix the subtract-instead-of-add bug in `sum.mjs` so
   `sum.test.mjs` passes; graded by re-running `node --test` (exit 0 only on a
   real fix).
7. **long-context-fix** — find and fix a percent-vs-fraction bug that spans
   `discount-rate.mjs` and `apply-discount.mjs` inside a ~35 file project the
   prompt never names (`long-context-fixture.ts`); graded by re-running the
   locked `node --test test/` suite. This is the task that grows the context
   enough to exercise prompt caps, prefix-cache misses, and compaction.
8. **long-context-followup** — the same fix inside a committed Git repo,
   followed by two short follow-up turns on the same agent. A tool-free question
   and a rerun of the tests add little new text, so a slow first round in turn
   2 or 3 means the earlier turns were re-read instead of served from the
   prefix cache.

## Metric definitions

- **compensation** — one count from the reliability layer that means the model's
  tool call was not clean: a repaired text-emitted call (`repairedToolCalls`), a
  hallucinated-name fix (`nameRepairs`), an empty-turn nudge (`stallNudges`), a
  schema validation/coercion failure (`validationFailures`), a whitespace-tolerant
  edit fix (`editRepairs`), or a corrective re-prompt (`reprompts`).
  `doomLoopTrips`, `verifyFlags`, & `verifyReprompts` are reported too but
  EXCLUDED from compensations — they aren't tool-format issues.
- **cleanlinessRate** — the share of tool activity that wasn't a compensation:

  ```
  cleanlinessRate = (toolCallsExecuted + compensations === 0)
    ? 1
    : 1 - compensations / (toolCallsExecuted + compensations)
  ```

  A run with no tool calls & no compensations is a clean `1`. Otherwise it falls
  as the model needs more help to land each call.

- **passed (per task)** — strict-majority pass across reps: a task passes when
  more than half of reps passed. Ties fail.
- **passRate (per model)** — total passing reps over total reps, so a 3-rep task
  weighs more than a 1-rep task.

Per-task counters and rates are the mean across reps; wall time and token
totals (including `firstRoundPromptTokens`, the system prompt plus task prompt
cost) are the median so one cold or stalled rep cannot swing the task. Model
headline rates are the mean across tasks; the model `first-round` figure is the
median across tasks. Each task line also shows median wall seconds and the
median total prompt-eval time across reps; multi-turn tasks add `follow-up
prefill`, the median prompt-eval time spent on the first round of each later
turn.

Sampling is pinned by default: every request sends `temperature: 0` and
`seed: <rep index>`, so reps differ from each other but a rerun reproduces the
same reps and before/after reports differ only by what changed. Pass
`--sampling model` to leave Ollama's own sampling in place. Hosted providers
ignore both.

Reports also retain per-round usage samples under each task's `runs`, in repetition order. Text output prints each rep and round (with its turn for multi-turn tasks) with prompt/decode counts, estimated context occupancy, model durations, and the completion reason. Missing durations and reasons are `null` in JSON and `unavailable` in text. Prompt-eval time is the cache signal: Ollama reports the full prompt in `prompt_eval_count` even when the prefix cache hits, so token counts cannot show a miss, while a round that re-reads earlier history takes visibly longer than one that only reads the new tail.

## Usage

Requires a running Ollama with each model already pulled.

```bash
# run every task once against one model
npm run eval -- gemma4:31b-mlx

# compare multiple models
npm run eval -- mistral qwen3-coder llama3.1

# 3 reps each, JSON output for downstream tooling
npm run --silent eval -- mistral --reps 3 --json

# a single task against a remote host
npm run eval -- mistral --task build-run --host http://192.168.1.50:11434

# persist each model's summed reliability across runs, then print the lifetime view
npm run eval -- mistral qwen3-coder --reps 3 --save-telemetry
```

Flags: `--reps <n>`, `--json`, `--task <id>` (repeatable; unknown ids fail
loudly), `--host <url>`, plus `--max-iterations <n>`, `--timeout <ms>`,
`--think <low|medium|high|on|off>`, `--sampling <pinned|model>`, and
`--save-telemetry`.

## Comparing runs

Save two `--json` reports, then diff them per model and per task:

```bash
npm run --silent eval -- qwen3.8:27b --reps 3 --json > before.json
# change something
npm run --silent eval -- qwen3.8:27b --reps 3 --json > after.json
npm run eval -- compare before.json after.json
```

Deltas are after minus before. Rates print in percentage points; wall time,
total prompt tokens, first-round prompt tokens (the system prompt cost),
prompt-eval time, and follow-up prefill time print as absolute and relative
change. A figure prints `n/a` when either report lacks it, as single-turn
tasks do for follow-up prefill. Only models and tasks present in both reports are
diffed; tasks on one side are listed, not dropped.

## Longitudinal telemetry (`--save-telemetry`)

Each rep already captures the model's reliability counters, but they normally
die with the process. With `--save-telemetry`, the harness sums every rep across
every task for a model into one entry and folds it into
an immutable record under `~/.coral/eval-telemetry.d/`, so reliability becomes
comparable across runs over time instead of just per-invocation. A legacy
`eval-telemetry.json` snapshot remains a read-only baseline when present.

This is a **separate store** from the interactive `~/.coral/telemetry.d/` that
the TUI's `/telemetry` reads: synthetic benchmark counters are kept out of the
real-usage signal. Its `sessions` count therefore reads as "number of eval runs
that included this model". After a saving run, the cumulative lifetime view is
printed below the per-run report (suppressed under `--json`).

## Caveats

- The harness uses Coral's built-in default tool permissions and **auto-approves
  every gated tool call** so runs are fully headless. User/project permission
  overrides are ignored to keep reports comparable. Eval agents do not opt into
  user-configured MCP servers, so local MCP availability cannot change a
  benchmark's toolset or results.
- Each rep executes in a fresh **throwaway temp dir** under the OS temp root
  (`coral-eval-*`, removed after the rep). It is not a sandbox — the agent can
  still run `bash`/`node` on the host, so only point it at models you trust.
- Each run is bounded by a **`maxIterations` cap** (default 15 per turn) and a
  per-rep timeout (default 120s, shared by every turn of the rep); a hit cap, doom-loop stop, or timeout yields a failed/aborted outcome
  even when the task grader accepts the partial result. Runtime errors also
  override a successful grade, while the grader's diagnostics remain available.
- Tasks run **sequentially**, not in parallel: a single local Ollama runner serves
  every rep, so concurrent reps would contend for the host. Each per-rep Agent is
  disposed before its throwaway workspace is removed, while Ollama's request
  `keep_alive` keeps the model warm across tasks. The harness does not assume
  exclusive ownership of the configured host, so it never issues a host-global
  model eviction; Ollama releases the model after `keep_alive` expires.
