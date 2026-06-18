// src/retrieval/ollama-embedder.ts
// Ollama-backed embedding provider

import { OllamaClient } from '../ollama/client.js'
import { DEFAULT_EMBEDDING_MODEL, type Embedder } from './types.js'

export class OllamaEmbedder implements Embedder
{
  constructor(
    private client: OllamaClient,
    public model = DEFAULT_EMBEDDING_MODEL,
    private signal?: AbortSignal
  )
  {}

  async embed(texts: string[]): Promise<number[][]>
  {
    return this.client.embed(this.model, texts, this.signal)
  }
}
