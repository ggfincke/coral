// src/ollama/errors.ts
// typed Ollama API & model identity failures

export type OllamaModelIdentityFailure =
  'missing' | 'ambiguous' | 'invalid_digest' | 'invalid_response'

export class OllamaApiError extends Error
{
  constructor(
    public readonly status: number,
    public readonly body: string
  )
  {
    super(
      body
        ? `Ollama API error: ${status} ${body}`
        : `Ollama API error: ${status}`
    )
    this.name = 'OllamaApiError'
  }
}

export class OllamaModelIdentityError extends Error
{
  constructor(
    public readonly kind: OllamaModelIdentityFailure,
    message: string
  )
  {
    super(message)
    this.name = 'OllamaModelIdentityError'
  }
}

export function isOllamaMissingModelError(error: unknown): boolean
{
  return (
    (error instanceof OllamaModelIdentityError && error.kind === 'missing') ||
    (error instanceof OllamaApiError && error.status === 404)
  )
}
