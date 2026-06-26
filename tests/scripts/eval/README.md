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

## The 6 tasks

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

Per-task metrics are the mean across reps; model headline rates are the mean
across tasks.

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
`--think <low|medium|high|on|off>`, and `--save-telemetry`.

## Longitudinal telemetry (`--save-telemetry`)

Each rep already captures the model's reliability counters, but they normally
die with the process. With `--save-telemetry`, the harness sums every rep across
every task for a model into one entry and folds it into
`~/.coral/eval-telemetry.json`, so reliability becomes comparable across runs
over time instead of just per-invocation.

This is a **separate file** from the interactive `~/.coral/telemetry.json` that
the TUI's `/telemetry` reads: synthetic benchmark counters are kept out of the
real-usage signal. The file's `sessions` count therefore reads as "number of
eval runs that included this model". After a saving run, the cumulative lifetime
view is printed below the per-run report (suppressed under `--json`).

## Caveats

- The harness uses Coral's built-in default tool permissions and **auto-approves
  every gated tool call** so runs are fully headless. User/project permission
  overrides are ignored to keep reports comparable.
- Each rep executes in a fresh **throwaway temp dir** under the OS temp root
  (`coral-eval-*`, removed after the rep). It is not a sandbox — the agent can
  still run `bash`/`node` on the host, so only point it at models you trust.
- Each run is bounded by a **`maxIterations` cap** (default 15) and a per-rep
  timeout (default 120s); a hit cap or timeout yields a failed/aborted outcome
  rather than hanging the suite.
- Tasks run **sequentially**, not in parallel: a single local Ollama runner serves
  every rep, so concurrent reps would thrash model load/unload and contend for the
  host. Models are kept warm across their own tasks and unloaded only when
  switching models.
