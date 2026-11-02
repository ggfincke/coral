// src/providers/model-ref.ts
// split a Coral model string into its inference provider and native name

export type HostedProvider = 'anthropic' | 'openai'
export type InferenceProvider = 'ollama' | HostedProvider

export const HOSTED_PROVIDERS: readonly HostedProvider[] = [
  'anthropic',
  'openai',
]

export interface ModelRef
{
  provider: InferenceProvider
  // provider-native model id without the Coral prefix
  name: string
}

// only these exact prefixes leave Ollama, so every existing Ollama name and
// namespace keeps resolving locally
export function parseModelRef(model: string): ModelRef
{
  for (const provider of HOSTED_PROVIDERS)
  {
    const prefix = `${provider}/`
    if (model.startsWith(prefix) && model.length > prefix.length)
    {
      return { provider, name: model.slice(prefix.length) }
    }
  }
  return { provider: 'ollama', name: model }
}

export function formatModelRef(provider: HostedProvider, name: string): string
{
  return `${provider}/${name}`
}
