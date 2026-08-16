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

// append a backend-specific missing-model hint when base already carries the error
export function withPullHint(base: string, model: string, sep: string): string
{
  if (model.startsWith('mlx:'))
  {
    return (
      `${base}${sep}If the MLX model is missing, put weights in CORAL_MLX_MODELS_DIR ` +
      `and install the worker with: uv sync --project packages/coral-backend`
    )
  }
  const ollamaName = model.startsWith('ollama:')
    ? model.slice('ollama:'.length)
    : model
  return `${base}${sep}If the model is missing, run: ollama pull ${ollamaName}`
}
