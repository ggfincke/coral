// src/inference/python-embedder.ts
// mlx embedder over the worker; digest asserted before and after embed

import { isEmbeddingProtocol, isModelProtocol } from '../protocol/index.js'
import type { Embedder, EmbeddingSpace } from '../retrieval/types.js'
import { isPlainObject } from '../utils/guards.js'
import type { WorkerSupervisor } from './worker-supervisor.js'

const SHA256_HEX = /^[a-f\d]{64}$/

function asDigest(value: unknown): string
{
  if (typeof value !== 'string')
  {
    throw new Error(
      'mlx embedding model identity requires a 64-character SHA-256 digest from model.show'
    )
  }
  const normalized = value.trim().toLowerCase()
  if (!SHA256_HEX.test(normalized))
  {
    throw new Error(
      'mlx embedding model identity requires a 64-character SHA-256 digest from model.show'
    )
  }
  return normalized
}

function asVectors(
  payload: Record<string, unknown>,
  expected: number
): number[][]
{
  if (!isEmbeddingProtocol(payload) || !('vectors' in payload))
  {
    throw new Error('worker embed result was not an EmbedResult payload')
  }
  const raw = payload.vectors
  if (!Array.isArray(raw))
  {
    throw new Error('worker embed result did not include vectors')
  }
  if (raw.length !== expected)
  {
    throw new Error(
      `worker embed response count mismatch: expected ${expected}, got ${raw.length}`
    )
  }
  return raw.map((row, index) =>
  {
    if (!Array.isArray(row) || row.length === 0)
    {
      throw new Error(`worker embed vector ${index} was empty or not an array`)
    }
    return row.map((value, dim) =>
    {
      if (typeof value !== 'number' || !Number.isFinite(value))
      {
        throw new Error(
          `worker embed vector ${index} dim ${dim} was not a finite number`
        )
      }
      return value
    })
  })
}

/**
 * Worker-backed embedder. Fail-closed on artifact digest drift, matching
 * OllamaEmbedder's before-and-after checks.
 */
export class PythonEmbedder implements Embedder
{
  constructor(
    private readonly worker: WorkerSupervisor,
    public readonly space: EmbeddingSpace,
    private readonly signal?: AbortSignal
  )
  {
    if (space.provider !== 'mlx')
    {
      throw new Error(
        `PythonEmbedder requires an mlx embedding space, got ${space.provider}`
      )
    }
  }

  async embed(texts: string[]): Promise<number[][]>
  {
    await this.assertDigest()
    if (texts.length === 0)
    {
      await this.assertDigest()
      return []
    }
    await this.ensureEmbedCapability()
    const payload = await this.worker.request(
      'embed',
      { model: this.space.displayModel, texts },
      this.signal
    )
    await this.assertDigest()
    return asVectors(payload, texts.length)
  }

  private async ensureEmbedCapability(): Promise<void>
  {
    await this.worker.ensure(this.signal)
    const methods = this.worker.handshakeResult()?.methods
    if (!methods?.includes('embed'))
    {
      throw new Error(
        'Python worker did not advertise embed; refuse to send it over a guessed schema.'
      )
    }
  }

  private async assertDigest(): Promise<void>
  {
    await this.worker.ensure(this.signal)
    const payload = await this.worker.request(
      'model.show',
      { name: this.space.displayModel },
      this.signal
    )
    if (!isPlainObject(payload) || !isModelProtocol(payload))
    {
      throw new Error('worker model.show result was not a ModelInfo payload')
    }
    const current = asDigest(payload.digest)
    if (current === this.space.artifactDigest) return
    throw new Error(
      `Embedding model ${this.space.displayModel} changed artifact identity during retrieval; retry so Coral can use the new embedding space`
    )
  }
}
