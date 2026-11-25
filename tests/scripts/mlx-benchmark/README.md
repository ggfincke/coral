# MLX benchmark decision (archived)

This directory holds the recorded evidence for the MLX work removed from PR
#64. The decision was **NO-GO**: Ollama stays Coral's only inference backend,
and no direct-MLX runtime code was merged.

The harness that produced this evidence has been removed. Its code is in git
history; commit `54a10f1` still has it under `tests/scripts/mlx-benchmark/`
(entrypoint `run.ts`, with `run` and `validate` commands). A rerun would need
that code restored and repaired first: its checked-in config cannot pass
preflight, and its correctness gates tracked the live eval task list instead of
a pinned one.

## Files

- `local-only-qwen38.result.json`: the recorded run result.
- `result.schema.json`: the schema that result was validated against.
- `local-only-qwen38.decision.json` and `local-only-qwen38.decision.md`: the
  decision derived from the result. Before the harness was removed, both were
  regenerated from the result and matched the checked-in files byte for byte.
- `benchmark.config.example.json`: the config used for the recorded run.

## The recorded decision

The configured comparison was intentionally one model family:

- installed Ollama `qwen3.8:27b-mlx`, manifest
  `5642e97495e1a088883805981563dcdc4a040c2f53388b7a41d1f24d3622cf7e`;
- pinned direct artifact `mlx-community/Qwen3.8-27B-nvfp4` at
  `5ff8ef173ad0d7c3aae92f0be43031a6ab8067c6`.

The official direct snapshot was metadata-only in the local Hugging Face cache:
its tokenizer and weight shards were not installed. The installed Ollama model
cannot be passed to stock MLX-LM without conversion, and a converter would be a
new custom runtime rather than the stock-server comparison the harness was
meant to decide. Downloads were forbidden, so the run stopped at the first
artifact gate and recorded `NO-GO` without launching MLX or producing
performance data. PR #64's custom worker was disqualified separately and stays
forensic only at SHA `39a33a45682007333b7db36fd71a4ef171fd81e0`.

The correctness gates of the recorded run covered the six eval tasks that
existed then: `read-report`, `single-edit`, `create-file`, `search-multi-edit`,
`build-run`, and `bug-fix-verify`.

## Fixed acceptance policy

These thresholds remain the entry gate for any future reconsideration. The
numbers are also stored in the result's `policy` field.

1. The pinned direct artifact must already exist locally at the exact revision;
   its tokenizer/template files and every shard referenced by the safetensors
   index must resolve to accessible regular files.
2. Every required coding, tool, context, lifecycle, and residency repetition
   must be present once, pass, and have a unique consecutive sequence number.
   Agent iteration limits, doom-loop stops, timeouts, and runtime errors fail a
   run even if its task grader accepts the partial result.
3. Tool and coding runs permit zero tool errors, parser/name repairs, validation
   failures, corrective reprompts, or stall nudges.
4. Each performance cell has two warmups and ten alternating paired runs. A
   paired-bootstrap 95% lower bound must show at least one 20% primary-metric
   improvement, while no aggregate or workload cell may permit a regression
   greater than 10%.
5. Peak RSS is sampled every 100 ms over the Coral/backend process tree and is
   compared as peak bytes above that runtime's unloaded baseline. MLX allocator
   active, cache, and peak bytes are separate mandatory fields for a runnable
   direct candidate and are never folded into process RSS.

The full matrix covered every deterministic coding task five times; seven exact
tool scenarios five times; short, 8K, resolved-ceiling, repeated-prefix, and
multi-round contexts five times; and three consecutive lifecycle and residency
passes.
