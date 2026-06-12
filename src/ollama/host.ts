// src/ollama/host.ts
// shared Ollama host config for tools outside the agent client

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434'

let ollamaHost = DEFAULT_OLLAMA_HOST

export function setOllamaHost(host: string | undefined): void
{
  ollamaHost = host ?? DEFAULT_OLLAMA_HOST
}

export function getOllamaHost(): string
{
  return ollamaHost
}
