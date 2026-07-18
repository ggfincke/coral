// src/utils/errors.ts
// shared unknown-error normalization helpers

// normalize unknown thrown values into an Error
export function toError(err: unknown): Error
{
  return err instanceof Error ? err : new Error(String(err))
}

// convert unknown thrown values into a readable message
export function toErrorMessage(err: unknown): string
{
  return toError(err).message
}

// append the standard ollama pull hint when base already carries the error
export function withPullHint(base: string, model: string, sep: string): string
{
  return `${base}${sep}If the model is missing, run: ollama pull ${model}`
}
