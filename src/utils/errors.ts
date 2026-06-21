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

// heuristic: does this error message look like a missing embedding model,
// so callers can suggest `ollama pull <model>`
export function isMissingModelError(message: string): boolean
{
  const normalized = message.toLowerCase()
  return (
    normalized.includes('model') ||
    normalized.includes('not found') ||
    normalized.includes('pull') ||
    normalized.includes('404')
  )
}
