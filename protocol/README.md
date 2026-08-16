# protocol/

Language-neutral JSON Schema (Draft 2020-12) is the source of truth for
Coral's Python/TypeScript boundary (D11). Do not hand-write parallel types.

## Which schema is used where

| Schema                    | Consumers                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec-events.schema.json` | `coral exec` JSONL (`src/cli/exec.ts`), Python SDK. Stream events plus the bare `CoralExecResult` object (`--output-format json` / `--result-file`). **Not** wrapped in the worker envelope.    |
| `envelope.schema.json`    | Phase 2+ worker stdio frames (`v`, `id`, `kind`, `method`, `payload`).                                                                                                                          |
| `handshake.schema.json`   | First worker request/result payloads inside the envelope. Result requires `methods` and `versions`. Optional request `modelsDir`.                                                               |
| `chat.schema.json`        | Ollama-dialect `ChatRequest` / `ChatResponse` (`src/types/inference.ts`). Durations are nanoseconds. `function.arguments` is an object. Streaming partial tool calls must set `function.index`. |
| `model.schema.json`       | `Model`, `ModelInfo` (incl. weight `size`), `ModelRef`, pinned `model.list` / `model.show` request payloads, and `{ models: Model[] }` list results.                                            |
| `embedding.schema.json`   | Worker `embed` request (`model` + `texts`) and result (`vectors` as JSON float arrays). No packed encodings.                                                                                    |

Exec JSONL is a **sibling** of the worker envelope. `coral exec` already emits
un-enveloped `{type, ...}` events; the SDK parses those directly.

### camelCase vs snake_case usage

| Channel                                           | Shape                                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| stream `usage` event                              | Agent `TokenUsage` camelCase (`promptTokens`, `completionTokens`, `promptEvalDurationNs`, …)                     |
| terminal `result.usage` / `CoralExecResult.usage` | snake_case four fields only: `prompt_tokens`, `completion_tokens`, `prompt_eval_duration_ns`, `eval_duration_ns` |

Do not normalize the split away in the schema.

## Codegen

```bash
npm run protocol:gen    # rewrite generated TS + Pydantic from these schemas
npm run protocol:check  # compare in-memory output to the exact checked-in file set
```

| Target             | Tool                                             | Output                                                                                                             |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| TS types           | `json-schema-to-typescript`                      | `src/protocol/generated/types.ts` (checked in)                                                                     |
| TS Ajv validators  | owned generator + existing `ajv` / `ajv-formats` | `src/protocol/generated/validators.ts` (schemas embedded; no runtime `protocol/` reads)                            |
| Pydantic v2 models | owned Node generator (see fallback below)        | `protocol/generated/python/`, plus the SDK's vendored `exec_events.py` generated from the same schema (checked in) |

`protocol:check` generates expected bytes in memory, compares exact paths and
contents, and never rewrites the checkout. It belongs in CI after `npm test`
(`.github/workflows/ci.yml`). `npm test` stays uv-free.

Generated files carry the two-line path + purpose header. Re-run
`protocol:gen` after editing a schema; never edit generated files by hand.

### Pydantic fallback (§6)

`datamodel-code-generator` is not an npm dependency. `protocol:gen` must run
from Node without uv so `protocol:check` can live in the TypeScript CI job.
The allowed §6 fallback is used: `scripts/protocol-gen.mjs` reads the same
JSON Schemas and emits Pydantic v2 models. Do not replace those with
hand-written models that can drift.

## Fixtures

`fixtures/valid/` and `fixtures/invalid/` hold one frame per file. Both TS
(`tests/protocol/`, Ajv) and later Python packages load the **same bytes**.
A fixture is green only if both sides agree. Never edit a fixture to match
one side.

Filename prefix selects the schema (`exec-`, `envelope-`, `handshake-`,
`chat-`, `model-`, `embedding-`).
