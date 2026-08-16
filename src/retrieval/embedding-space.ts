// src/retrieval/embedding-space.ts
// v3 embedding-space identity and fail-closed artifact drift checks

import { createHash } from 'node:crypto'
import type { OllamaClient, OllamaModelArtifact } from '../ollama/client.js'
import { normalizeOllamaHost } from '../ollama/host.js'
import type { EmbeddingProvider, EmbeddingSpace } from './types.js'

const SPACE_ID_VERSION = 'coral/embedding-space/v3'
const SHA256_HEX = /^[a-f\d]{64}$/

export function embeddingSpaceId(
  provider: EmbeddingProvider,
  endpointIdentity: string | undefined,
  artifactDigest: string
): string
{
  return createHash('sha256')
    .update(SPACE_ID_VERSION)
    .update('\0')
    .update(provider)
    .update('\0')
    .update(endpointIdentity ?? '')
    .update('\0')
    .update(artifactDigest)
    .digest('hex')
}

function artifactDigest(value: unknown): string
{
  if (typeof value !== 'string')
  {
    throw new Error(
      'Embedding model identity requires a 64-character SHA-256 artifact digest'
    )
  }
  const normalized = value.trim().toLowerCase()
  if (!SHA256_HEX.test(normalized))
  {
    throw new Error(
      'Embedding model identity requires a 64-character SHA-256 artifact digest'
    )
  }
  return normalized
}

function assertProvider(value: unknown): EmbeddingProvider
{
  if (value === 'ollama' || value === 'mlx') return value
  throw new Error("Embedding-space provider must be 'ollama' or 'mlx'")
}

// validate a deserialized space before it selects an on-disk cache
export function assertEmbeddingSpace(space: EmbeddingSpace): void
{
  if (typeof space?.id !== 'string' || !SHA256_HEX.test(space.id))
  {
    throw new Error(
      'Embedding-space ID must be a lowercase 64-character SHA-256 hash'
    )
  }
  const provider = assertProvider(space.provider)
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
  if (
    space.dimensions !== undefined &&
    (!Number.isInteger(space.dimensions) || space.dimensions <= 0)
  )
  {
    throw new Error('Embedding-space dimensions must be a positive integer')
  }

  let endpointIdentity: string | undefined
  if (space.endpointIdentity !== undefined)
  {
    if (
      typeof space.endpointIdentity !== 'string' ||
      space.endpointIdentity !== space.endpointIdentity.trim()
    )
    {
      throw new Error(
        'Embedding-space endpoint identity must be a trimmed string when set'
      )
    }
    endpointIdentity = space.endpointIdentity
  }

  if (provider === 'ollama')
  {
    if (typeof endpointIdentity !== 'string' || !endpointIdentity)
    {
      throw new Error('Embedding-space Ollama host must be a normalized URL')
    }
    const normalizedHost = normalizeOllamaHost(endpointIdentity)
    if (normalizedHost !== endpointIdentity)
    {
      throw new Error('Embedding-space Ollama host must already be normalized')
    }
  }
  else if (!endpointIdentity)
  {
    throw new Error(
      'Embedding-space mlx endpoint identity must be a models-dir path'
    )
  }

  if (
    space.id !==
    embeddingSpaceId(provider, endpointIdentity, space.artifactDigest)
  )
  {
    throw new Error(
      'Embedding-space ID does not match its provider, endpoint, and artifact digest'
    )
  }
}

export function createEmbeddingSpace(
  host: string,
  artifact: OllamaModelArtifact
): EmbeddingSpace
{
  const endpointIdentity = normalizeOllamaHost(host)
  const digest = artifactDigest(artifact.digest)
  const displayModel =
    typeof artifact.model === 'string' ? artifact.model.trim() : ''
  if (!displayModel)
  {
    throw new Error('Ollama embedding model identity requires a model name')
  }

  const space = Object.freeze({
    id: embeddingSpaceId('ollama', endpointIdentity, digest),
    provider: 'ollama' as const,
    endpointIdentity,
    artifactDigest: digest,
    displayModel,
  })
  assertEmbeddingSpace(space)
  return space
}

export function createMlxEmbeddingSpace(input: {
  endpointIdentity: string
  artifactDigest: string
  displayModel: string
  dimensions?: number
}): EmbeddingSpace
{
  const endpointIdentity = input.endpointIdentity.trim()
  const displayModel = input.displayModel.trim()
  const digest = artifactDigest(input.artifactDigest)
  if (!endpointIdentity)
  {
    throw new Error(
      'Embedding-space mlx endpoint identity must be a models-dir path'
    )
  }
  if (!displayModel)
  {
    throw new Error('mlx embedding model identity requires a model name')
  }
  const space: EmbeddingSpace = {
    id: embeddingSpaceId('mlx', endpointIdentity, digest),
    provider: 'mlx',
    endpointIdentity,
    artifactDigest: digest,
    displayModel,
  }
  if (input.dimensions !== undefined) space.dimensions = input.dimensions
  const frozen = Object.freeze(space)
  assertEmbeddingSpace(frozen)
  return frozen
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
  if (space.provider !== 'ollama')
  {
    throw new Error(
      `Ollama embedder cannot use a ${space.provider} embedding space`
    )
  }
  const current = await client.resolveModelArtifact(space.displayModel, signal)
  if (current.digest === space.artifactDigest) return

  throw new Error(
    `Embedding model ${space.displayModel} changed artifact identity during retrieval; retry so Coral can use the new embedding space`
  )
}
