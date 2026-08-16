// src/retrieval/build.ts
// retrieval index construction

import { formatWorkerInstallError } from '../config/inference.js'
import { OllamaClient } from '../ollama/client.js'
import { isOllamaMissingModelError } from '../ollama/errors.js'
import { normalizeOllamaHost } from '../ollama/host.js'
import {
  canonicalEmbeddingModel,
  embeddingBackendName,
  resolveRetrievalConfig,
} from './config.js'
import { resolveOllamaEmbeddingSpace } from './embedding-space.js'
import { ProjectIndexer } from './indexer.js'
import { OllamaEmbedder } from './ollama-embedder.js'
import { SqliteIndexStore } from './sqlite-store.js'
import {
  DEFAULT_EMBEDDING_MODEL,
  type Embedder,
  type EmbeddingSpace,
  type IndexStore,
} from './types.js'
import { toError } from '../utils/errors.js'

// construction seams for the embedder, store, and indexer
export interface RetrievalDeps
{
  createStore?: (space: EmbeddingSpace) => IndexStore
  createClient?: (ollamaHost: string) => OllamaClient
  resolveSpace?: (
    client: OllamaClient,
    ollamaHost: string,
    embeddingModel: string,
    signal?: AbortSignal
  ) => Promise<EmbeddingSpace>
  createEmbedder?: (space: EmbeddingSpace, signal?: AbortSignal) => Embedder
}

export interface BuiltIndexer
{
  indexer: ProjectIndexer
  store: IndexStore
  embeddingModel: string
  embeddingSpace: EmbeddingSpace
}

export type RetrievalBuildFailureKind = 'missing_model' | 'build'

export class RetrievalBuildError extends Error
{
  public readonly kind: RetrievalBuildFailureKind

  constructor(
    public readonly embeddingModel: string,
    cause: unknown
  )
  {
    const error = toError(cause)
    super(error.message, { cause: error })
    this.name = 'RetrievalBuildError'
    this.kind = isOllamaMissingModelError(error) ? 'missing_model' : 'build'
  }
}

export interface RetrievalFailure
{
  embeddingModel: string
  message: string
  missingModel: boolean
}

export function describeRetrievalFailure(
  error: unknown,
  fallbackModel: string
): RetrievalFailure
{
  if (error instanceof RetrievalBuildError)
  {
    return {
      embeddingModel: error.embeddingModel,
      message: error.message,
      missingModel: error.kind === 'missing_model',
    }
  }

  const normalized = toError(error)
  return {
    embeddingModel: fallbackModel,
    message: normalized.message,
    missingModel: isOllamaMissingModelError(normalized),
  }
}

function defaultEmbedder(
  space: EmbeddingSpace,
  client: OllamaClient,
  signal: AbortSignal | undefined,
  createEmbedder: RetrievalDeps['createEmbedder']
): Embedder
{
  if (createEmbedder) return createEmbedder(space, signal)
  if (space.provider === 'ollama')
  {
    return new OllamaEmbedder(client, space, signal)
  }
  throw new Error(
    formatWorkerInstallError(
      'mlx embeddings require an injected createEmbedder at the composition root.'
    )
  )
}

// build the project indexer and return its caller-owned store
// close the store when construction fails or the indexer is no longer needed
export async function buildIndexer(
  cwd: string,
  ollamaHost: string,
  signal?: AbortSignal,
  deps: RetrievalDeps = {}
): Promise<BuiltIndexer>
{
  let embeddingModel = DEFAULT_EMBEDDING_MODEL
  let store: IndexStore | undefined

  try
  {
    const config = resolveRetrievalConfig(cwd)
    embeddingModel = canonicalEmbeddingModel(config)
    const { provider, name } = embeddingBackendName(config)
    if (provider === 'mlx' && (!deps.resolveSpace || !deps.createEmbedder))
    {
      throw new Error(
        formatWorkerInstallError(
          'mlx embeddings need resolveSpace and createEmbedder injected from the TUI or exec composition root.'
        )
      )
    }
    const normalizedHost = normalizeOllamaHost(ollamaHost)
    const client =
      deps.createClient?.(normalizedHost) ?? new OllamaClient(normalizedHost)
    const embeddingSpace = deps.resolveSpace
      ? await deps.resolveSpace(client, normalizedHost, embeddingModel, signal)
      : await resolveOllamaEmbeddingSpace(client, normalizedHost, name, signal)
    store =
      deps.createStore?.(embeddingSpace) ?? new SqliteIndexStore(embeddingSpace)
    const embedder = defaultEmbedder(
      embeddingSpace,
      client,
      signal,
      deps.createEmbedder
    )
    const indexer = new ProjectIndexer(cwd, embedder, store)
    return {
      indexer,
      store,
      embeddingModel,
      embeddingSpace,
    }
  }
  catch (err)
  {
    store?.close?.()
    throw new RetrievalBuildError(embeddingModel, err)
  }
}
