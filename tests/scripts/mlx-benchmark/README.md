# MLX benchmark decision harness

This directory is the benchmark-only decision plane for the MLX work removed
from PR #64. It imports Coral's existing Agent and six deterministic coding
tasks, but it does not add an inference backend, protocol, package, retrieval
provider, SDK, plugin system, or user-facing support claim.

## Current local-only decision

The configured comparison is intentionally one model family:

- installed Ollama `qwen3.8:27b-mlx`, manifest
  `5642e97495e1a088883805981563dcdc4a040c2f53388b7a41d1f24d3622cf7e`;
- pinned direct artifact `mlx-community/Qwen3.8-27B-nvfp4` at
  `5ff8ef173ad0d7c3aae92f0be43031a6ab8067c6`.

The official direct snapshot is metadata-only in the local Hugging Face cache:
its tokenizer and weight shards are not installed. The installed Ollama model
cannot be passed to stock MLX-LM without conversion, and a converter would be a
new custom runtime rather than the stock-server comparison this harness is
meant to decide. Downloads and environment sync are forbidden. Therefore the
checked-in local result stops at the first artifact gate and records `NO-GO`;
it does not launch MLX or fabricate performance data.

The Ollama half is independently live-probed with temperature 0, thinking off,
and a 4,096-token context. That smoke proves only that the installed baseline
can answer; it does not substitute for the full Agent, tool, lifecycle, or
performance matrix.

## Run the local preflight

Set explicit paths; the harness never infers a missing model and never pulls:

```bash
export CORAL_BACKEND_PROJECT=/Users/ggfincke/Projects/Experiments/coral/packages/coral-backend
export CORAL_CUSTOM_CANDIDATE=/Users/ggfincke/Projects/Experiments/coral
export CORAL_UV=/opt/homebrew/bin/uv
export CORAL_MLX_BENCHMARK_SERVER=$PWD/tests/scripts/mlx-benchmark/server_with_metrics.py
export CORAL_OLLAMA_QWEN38_MANIFEST=/Users/ggfincke/.ollama/models/manifests/registry.ollama.ai/library/qwen3.8/27b-mlx
export CORAL_QWEN38_MLX_SNAPSHOT=/Users/ggfincke/.cache/huggingface/hub/models--mlx-community--Qwen3.8-27B-nvfp4/snapshots/5ff8ef173ad0d7c3aae92f0be43031a6ab8067c6

npx --no-install tsx tests/scripts/mlx-benchmark/run.ts run \
  --config tests/scripts/mlx-benchmark/benchmark.config.example.json
```

Exit 2 is the expected policy result for a schema-valid no-go. Exit 1 means the
harness/configuration itself failed. A result is written after every bounded
stage, and all eventual subprocesses use argv arrays rather than a shell. Before
writing evidence, the runner verifies the configured Git, Node, Ollama, uv,
Python, MLX, MLX-LM, hardware, macOS, and power identities using only installed
local runtimes.

Validate any complete result independently:

```bash
npx --no-install tsx tests/scripts/mlx-benchmark/run.ts validate \
  --result tests/scripts/mlx-benchmark/local-only-qwen38.result.json \
  --schema tests/scripts/mlx-benchmark/result.schema.json
```

## Fixed acceptance policy

Result files cannot choose weaker thresholds or omit a bad repetition:

1. The pinned direct artifact must already exist locally at the exact revision;
   its tokenizer/template files and every shard referenced by the safetensors
   index must resolve to accessible regular files.
2. Every required coding, tool, context, lifecycle, and residency repetition
   must be present once, pass, and have a unique consecutive sequence number.
   Context prompts are calibrated per topology before the measured repetitions;
   each row records and must reach the actual tokenizer-reported prompt count.
3. Tool and coding runs permit zero tool errors, parser/name repairs, validation
   failures, corrective reprompts, or stall nudges.
4. Each performance cell has two warmups and ten alternating paired runs. A
   paired-bootstrap 95% lower bound must show at least one 20% primary-metric
   improvement, while no aggregate or workload cell may permit a regression
   greater than 10%.
5. Peak RSS is sampled every 100 ms over the Coral/backend process tree and is
   compared as peak bytes above that runtime's unloaded baseline. Absolute and
   unloaded values remain alongside the primary delta. MLX allocator active,
   cache, and peak bytes are separate fields and are mandatory for a runnable
   direct candidate; they are never folded into process RSS.

The full matrix includes all six existing deterministic coding tasks five times;
seven exact tool scenarios five times; short, 8K, resolved-ceiling, repeated-
prefix, and multi-round contexts five times; and three consecutive lifecycle
and residency passes. Lifecycle exercises prefill cancellation, decode
cancellation, an actual deadline, crash/restart, a successful next request, and
mid-generation shutdown with no surviving descendants. With one model family,
residency is same-model reuse plus direct MLX -> fully unloaded -> Ollama ->
fully unloaded -> direct MLX.

Stock MLX is a Coral-owned child bound to exact `127.0.0.1`; every launch uses
an OS-selected random loopback port with a bounded retry count and one total
startup deadline. The config passes an empty allowed-origin value and the
runner verifies a hostile browser Origin is not reflected. The child gets a 16
KiB stdout/stderr diagnostic tail, process-group retirement, and joined
SIGTERM/SIGKILL fallback. Retirement rescans the owned process group until it
is empty, covering late forks in the pinned non-daemonizing stock server; the
custom worker is never launched and remains forensic only at PR #64 SHA
`39a33a45682007333b7db36fd71a4ef171fd81e0`.

The pinned server intentionally starts without `--model`: MLX-LM 0.31.3 loads
the exact request model on demand, which preserves a genuinely unloaded RSS
baseline. Its child receives only the fully recorded launch environment; it
does not inherit ambient process variables.

The benchmark-only launcher is strictly allocator instrumentation over stock
inference: it does not replace MLX-LM's model provider, response generator,
tokenizer/tool parser, or generation path. It adds only a read-only loopback
endpoint for MLX active, cache, and peak allocator counters. The runner resets
the peak counter immediately before each measured request; these values remain
separate from process-tree RSS.

If a future, already-installed direct artifact clears preflight, the harness
will continue into the live stock matrix. Executing or selecting a corrected
custom candidate is deliberately fail-closed until a separate experimental
candidate has a pinned checkout, no-download lifecycle, required-capability
evidence, and a direct paired result contract. A nonempty config string alone
cannot override stock.
