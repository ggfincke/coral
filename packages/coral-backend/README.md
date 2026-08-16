# Coral MLX inference worker

Unpublished local package (`packages/coral-backend`). Own uv project (D14), not a
workspace member of repo-root `coral-dev-tools`. Not published to PyPI.

Speaks the versioned NDJSON envelope on stdio (`protocol/envelope.schema.json`).
Uses `mlx_lm` as a library. Emits Ollama-dialect `ChatResponse` chunks.

## Run

From the Coral checkout:

```bash
uv sync --project packages/coral-backend
uv run --project packages/coral-backend python -m coral_backend
```

Or after syncing this directory: `uv run python -m coral_backend`.

stdout is protocol-only. Human logs go to stderr.

`CORAL_MLX_MODELS_DIR` (wins) or handshake payload `modelsDir` / `mlxModelsDir`
is the checkpoint inventory root. Default: `~/.coral/mlx-models`. Each model is
a directory with `config.json` plus weight files (`.safetensors`, `.npz`, …).

Requires standard CPython 3.14 on macOS arm64 (not `3.14t`). mlx 0.32.0 has no
cp314t wheel.

## Tests

From this directory:

```bash
uv sync
uv run python -m unittest discover -s tests -v
```

From the Coral repo root:

```bash
uv run --project packages/coral-backend python -m unittest discover -s packages/coral-backend/tests -v
```

If a parent virtualenv is active, prefer `packages/coral-backend/.venv/bin/python -m unittest discover -s tests -v` from this directory so the worker subprocess uses the same interpreter.

Seam: set `CORAL_FAKE_GENERATE` to a JSON script, or `CORAL_BACKEND_MODULE` to a
module exporting `create_backend()`. See `src/coral_backend/fake.py`.

TypeScript real-spawn tests live in `tests/inference/worker-e2e.test.ts`. They
are **off** during plain `npm test` so that job stays uv-free. Enable with
`CORAL_WORKER_E2E=1` (still skips cleanly if `uv` and `packages/coral-backend/.venv`
are both missing):

```bash
CORAL_WORKER_E2E=1 npx tsx --test tests/inference/worker-e2e.test.ts
```

## Live MLX smoke (M4 Max)

Not in CI. Needs a real MLX chat checkpoint and a synced worker.

1. Sync the worker: `uv sync --project packages/coral-backend` (CPython 3.14, not `3.14t`).
2. Put the checkpoint under `CORAL_MLX_MODELS_DIR` (default `~/.coral/mlx-models`). Layout:

   ```
   $CORAL_MLX_MODELS_DIR/
     <name>/              # this <name> is what coral -m mlx:<name> selects
       config.json
       *.safetensors      # or .npz / other weight files the inventory scanner accepts
   ```

   Nested dirs up to 3 deep are listed as posix-relative names (`org/model`).

3. Run Coral against it: `coral -m mlx:<name>` (or `npx tsx src/cli/main.tsx -m mlx:<name>` from the checkout).
4. Verify:
   - tokens stream into the TUI (not a single dump at the end)
   - a tool-using prompt actually calls tools (read/grep is enough)
   - `/model` lists mlx rows next to ollama
   - a `task` subagent turn uses the same mlx client (not a surprise Ollama hop)
   - Esc/cancel stops generation; the next prompt still works
   - `/status` shows the pinned context window (gemma artifacts should pin native)
   - after quit, `pgrep -lf coral_backend` / `pgrep -lf mlx` shows no leftover worker
5. Missing worker should print the install error naming `uv sync --project packages/coral-backend`, not a stack trace.

## Failure modes

| Failure                                 | Automated? | Where                                                                                                   |
| --------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| worker package missing / uv not synced  | yes        | `tests/inference/worker-supervisor.test.ts`, `tests/cli/exec.test.ts` (`mlx:foo` + missing interpreter) |
| wrong Python (3.13, 3.14t, missing mlx) | copy only  | install error names CPython 3.14; live interpreter mismatch is manual                                   |
| `mlx:` selected but artifacts missing   | yes        | `tests/inference/worker-e2e.test.ts` (`CORAL_MLX_MODELS_DIR` in the error)                              |
| OOM during load or generate             | no         | needs real weights; supervisor restart-once is tested via kill                                          |
| crash mid-stream                        | yes (kill) | e2e restart-once; second crash stays dead                                                               |
| cancel during generate                  | yes        | e2e AbortSignal; Python `test_envelope.py`                                                              |
| cancel vs process-exit race             | yes        | e2e dispose asserts the pid is gone                                                                     |
| handshake version / missing methods     | yes        | `tests/inference/worker-supervisor.test.ts` (fake transport)                                            |
| unknown backend prefix                  | yes        | `tests/inference/model-ref.test.ts`                                                                     |

## Tool-call families

Parsers cover the families Coral targets:

| Family           | Markers                                         | Body                                        |
| ---------------- | ----------------------------------------------- | ------------------------------------------- |
| `qwen`           | `<tool_call>` … `</tool_call>`                  | JSON `{name, arguments}`                    |
| `qwen3_coder`    | same wrappers                                   | `<function=name><parameter=k>v</parameter>` |
| `gemma4`         | `<\|tool_call>` … `<tool_call\|>`               | JSON or `call name(k=v)`                    |
| `function_gemma` | `<start_function_call>` … `<end_function_call>` | `call:name{k:v}`                            |

Other families fail closed if the request includes tools or the model emits
known-unsupported markup (`[TOOL_CALLS]`, Kimi/MiniMax/… tokens).

## Embeddings (Phase 3)

The worker advertises `embed` on handshake. Request payload is
`{ model, texts: string[] }`; the result is `{ vectors: number[][] }` (JSON
floats only — no packed encodings). `model` is the checkpoint remainder, same
as `model.show` `name`.

Default Coral embedding model stays **Ollama** `nomic-embed-text`. To use MLX
embeddings, set `CORAL_EMBEDDING_MODEL=mlx:<name>` or project `.coral.json`:

```json
{
  "retrieval": {
    "provider": "mlx",
    "embeddingModel": "Qwen3-Embedding-0.6B"
  }
}
```

Recommended checkpoint: **Qwen3-Embedding-0.6B** as a **raw MLX directory**
(config.json + weight files + tokenizer), not the GPL-3 `mlx-embeddings`
package. Do not add `mlx-embeddings`, `sentence-transformers`, or torch to this
project. Convert from Hugging Face with `mlx_lm.convert` (or download an
already-converted MLX tree) into:

```
$CORAL_MLX_MODELS_DIR/Qwen3-Embedding-0.6B/
  config.json
  *.safetensors
  tokenizer.json
  tokenizer_config.json
```

Then `coral` indexes under `CORAL_HOME/retrieval/v3/spaces/`. SQLite stays in
the TypeScript process; this worker never opens the DB.

The fake seam (`CORAL_FAKE_GENERATE`) accepts an `embed` object:
`{ "dimensions": 8 }` or `{ "vectors": [[...], ...] }` so tests never load
weights. Live MLX embed mean-pools the transformer body (`model.model`) and
L2-normalizes; checkpoints without that body fail closed.

Embedding cancellation inside the worker is cooperative at text boundaries.
`mlx_lm` does not expose safe preemption for an in-flight tensor call, so the
worker keeps the request busy and shared model state resident until that call
returns. A cancelled request emits no vectors. The TypeScript supervisor waits
250 ms for a terminal frame; a cooperative terminal preserves the loaded
worker, while a missing terminal blocks new requests, lets unrelated admitted
work drain, and recycles the worker process. This avoids reusing shared model
state while an abandoned call is still running.

### Artifact digest (`coral/mlx-artifact/v1`)

Stable SHA-256 over the checkpoint, exposed as `digest` on `model.show` and
`model.list`. TypeScript asserts it before and after every `embed()`.

Outer hash:

1. version string `coral/mlx-artifact/v1` + NUL
2. for each included file, POSIX-relative path (case-sensitive sort) + NUL +
   SHA-256(file bytes) + NUL

Included files:

- root `config.json`
- weight suffixes: `.safetensors`, `.npz`, `.gguf`, `.bin`, `.pt`, `.ggml`, `.mlx`
- `*.safetensors.index.json`
- tokenizer / template basenames: `tokenizer.json`, `tokenizer.model`,
  `tokenizer_config.json`, `special_tokens_map.json`, `vocab.json`,
  `merges.txt`, `added_tokens.json`, `sentencepiece.bpe.model`,
  `spiece.model`, `chat_template.jinja`, `chat_template.json`,
  `processor_config.json`, `preprocessor_config.json`

Skipped directory names: `.git`, `__pycache__`, `.venv`, `node_modules`, and
any dot-directory. Changing any included file changes the digest (fail-closed).
