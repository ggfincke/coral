// src/retrieval/embedding-space.ts
// stable Ollama embedding-space identity & drift checks

import { createHash } from 'node:crypto'
import type { OllamaClient, OllamaModelArtifact } from '../ollama/client.js'
import { normalizeOllamaHost } from '../ollama/host.js'
import type { EmbeddingSpace } from './types.js'

const SPACE_ID_VERSION = 'coral/ollama-embedding-space/v1'
const SHA256_HEX = /^[a-f\d]{64}$/

function spaceId(normalizedHost: string, artifactDigest: string): string
{
  return createHash('sha256')
    .update(SPACE_ID_VERSION)
    .update('\0')
    .update(normalizedHost)
    .update('\0')
    .update(artifactDigest)
    .digest('hex')
}

function artifactDigest(value: unknown): string
{
  if (typeof value !== 'string')
  {
    throw new Error(
      'Ollama embedding model identity requires a 64-character SHA-256 digest from /api/tags'
    )
  }
  const normalized = value.trim().toLowerCase()
  if (!SHA256_HEX.test(normalized))
  {
    throw new Error(
      'Ollama embedding model identity requires a 64-character SHA-256 digest from /api/tags'
    )
  }
  return normalized
}

// validate deserialized spaces before they can select an on-disk cache
export function assertEmbeddingSpace(space: EmbeddingSpace): void
{
  if (typeof space?.id !== 'string' || !SHA256_HEX.test(space.id))
  {
    throw new Error(
      'Embedding-space ID must be a lowercase 64-character SHA-256 hash'
    )
  }
  if (
    typeof space.artifactDigest !== 'string' ||
    !SHA256_HEX.test(space.artifactDigest)
  )
  {
    throw new Error(
      'Embedding-space artifact digest must be a lowercase 64-character SHA-256 hash'
    )
  }
  if (
    typeof space.displayModel !== 'string' ||
    !space.displayModel ||
    space.displayModel !== space.displayModel.trim()
  )
  {
    throw new Error(
      'Embedding-space display model must be a non-empty trimmed name'
    )
  }

  if (typeof space.normalizedHost !== 'string')
  {
    throw new Error('Embedding-space Ollama host must be a normalized URL')
  }
  const normalizedHost = normalizeOllamaHost(space.normalizedHost)
  if (normalizedHost !== space.normalizedHost)
  {
    throw new Error('Embedding-space Ollama host must already be normalized')
  }
  if (space.id !== spaceId(normalizedHost, space.artifactDigest))
  {
    throw new Error(
      'Embedding-space ID does not match its host and artifact digest'
    )
  }
}

export function createEmbeddingSpace(
  host: string,
  artifact: OllamaModelArtifact
): EmbeddingSpace
{
  const normalizedHost = normalizeOllamaHost(host)
  const digest = artifactDigest(artifact.digest)
  const displayModel =
    typeof artifact.model === 'string' ? artifact.model.trim() : ''
  if (!displayModel)
  {
    throw new Error('Ollama embedding model identity requires a model name')
  }

  const space = Object.freeze({
    id: spaceId(normalizedHost, digest),
    normalizedHost,
    artifactDigest: digest,
    displayModel,
  })
  assertEmbeddingSpace(space)
  return space
}

export async function resolveOllamaEmbeddingSpace(
  client: OllamaClient,
  host: string,
  model: string,
  signal?: AbortSignal
): Promise<EmbeddingSpace>
{
  return createEmbeddingSpace(
    host,
    await client.resolveModelArtifact(model, signal)
  )
}

export async function assertOllamaEmbeddingSpace(
  client: OllamaClient,
  space: EmbeddingSpace,
  signal?: AbortSignal
): Promise<void>
{
  assertEmbeddingSpace(space)
  const current = await client.resolveModelArtifact(space.displayModel, signal)
  if (current.digest === space.artifactDigest) return

  throw new Error(
    `Embedding model ${space.displayModel} changed artifact identity during retrieval; retry so Coral can use the new embedding space`
  )
}
