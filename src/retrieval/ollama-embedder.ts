// src/retrieval/ollama-embedder.ts
// embedding provider backed by Ollama

import { OllamaClient } from '../ollama/client.js'
import { assertOllamaEmbeddingSpace } from './embedding-space.js'
import type { Embedder, EmbeddingSpace } from './types.js'

export class OllamaEmbedder implements Embedder
{
  constructor(
    private client: OllamaClient,
    public space: EmbeddingSpace,
    private signal?: AbortSignal
  )
  {}

  async embed(texts: string[]): Promise<number[][]>
  {
    await assertOllamaEmbeddingSpace(this.client, this.space, this.signal)
    const embeddings = await this.client.embed(
      this.space.displayModel,
      texts,
      this.signal
    )
    await assertOllamaEmbeddingSpace(this.client, this.space, this.signal)
    return embeddings
  }
}
