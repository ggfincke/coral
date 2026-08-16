# MLX benchmark decision

- Run: `qwen38-local-only-2026-08-16`
- Verdict: **NO-GO**
- Baseline: `ollama`
- Selected: `none`
- Generated: 2026-08-16T16:06:22.860Z

## Decision

Decision: **NO-GO.** Neither evaluated direct-MLX topology qualified for production integration. The pinned stock MLX-LM artifact was not locally installed, downloads were forbidden, and the available Ollama artifact had no stock-compatible zero-copy MLX-LM ingress. Correctness and performance measurement therefore did not proceed. PR #64's custom worker was separately disqualified by confirmed activation, parser, transport, cancellation, restart, cleanup, and residency defects. Ollama remains Coral's sole production inference backend, and no direct-MLX runtime code will be merged from this effort.

## stock-mlx-lm-server

- Hard gates: fail
- Performance bounds: fail
- Material improvement: fail

Failures:

- stock-mlx-lm-server/qwen38-27b-nvfp4 pinned direct artifact failed: pinned direct artifact mlx-community/Qwen3.8-27B-nvfp4@5ff8ef173ad0d7c3aae92f0be43031a6ab8067c6 is not installed and benchmark downloads are forbidden: pinned direct artifact omitted or could not verify tokenizer.json; tokenizer_config.json; 3 of 3 accessible safetensors weight shards

## Decision failures

- stock-mlx-lm-server/qwen38-27b-nvfp4 pinned direct artifact failed: pinned direct artifact mlx-community/Qwen3.8-27B-nvfp4@5ff8ef173ad0d7c3aae92f0be43031a6ab8067c6 is not installed and benchmark downloads are forbidden: pinned direct artifact omitted or could not verify tokenizer.json; tokenizer_config.json; 3 of 3 accessible safetensors weight shards
- artifact preflight blocked correctness and performance runs

## Local model evidence

### qwen38-27b-nvfp4

- Observed locally: the Ollama manifest totals 18,174,721,596 bytes across 1,209 layers; its 1,199 one-tensor ModelOpt safetensors blobs total 18,155,017,220 bytes.
- Measured preflight: the local view has 2,017 keys including 409 .scale and 409 .global_scale keys; mlx-lm 0.31.3 with mlx 0.32.0 rejects 802 of them as unexpected.
- Observed in the pinned official index: 1,682 keys including 498 plural .scales keys and no .global_scale keys.
- Decision inference: the layouts have no stock/no-copy ingress, and conversion is outside this benchmark and forbidden by the local-only constraint.

## Forensic topology

### pr64-custom-worker

- Revision: `39a33a45682007333b7db36fd71a4ef171fd81e0`
- Disposition: **disqualified**

- ordinary model-picker activation eagerly starts Python work
- handwritten family parsing does not use the pinned tokenizer-native Qwen contract
- malformed or mismatched frames can poison pending transport state
- cancellation does not reliably retire the active generation
- crash recovery does not provide one bounded clean restart
- shutdown does not join every worker descendant
- A-B-A switching does not prove complete unload and residency transitions
