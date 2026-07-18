// src/retrieval/build.ts
// shared construction of the embedder-backed project indexer

import { OllamaClient } from '../ollama/client.js'
import { isOllamaMissingModelError } from '../ollama/errors.js'
import { normalizeOllamaHost } from '../ollama/host.js'
import { resolveRetrievalConfig } from '../config/retrieval.js'
import { resolveOllamaEmbeddingSpace } from './embedding-space.js'
import { ProjectIndexer } from './indexer.js'
import { OllamaEmbedder } from './ollama-embedder.js'
import { SqliteIndexStore } from './sqlite-store.js'
import {
  DEFAULT_EMBEDDING_MODEL,
  type EmbeddingSpace,
  type IndexStore,
} from './types.js'
import { toError } from '../utils/errors.js'

// swappable construction seams for tests
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

// wire up store + client + embedder + indexer for a project. caller owns the
// returned store & must close it; on construction failure the store is closed
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
    embeddingModel = config.embeddingModel
    const normalizedHost = normalizeOllamaHost(ollamaHost)
    const client =
      deps.createClient?.(normalizedHost) ?? new OllamaClient(normalizedHost)
    const embeddingSpace = await (
      deps.resolveSpace ?? resolveOllamaEmbeddingSpace
    )(client, normalizedHost, config.embeddingModel, signal)
    store =
      deps.createStore?.(embeddingSpace) ?? new SqliteIndexStore(embeddingSpace)
    const embedder = new OllamaEmbedder(client, embeddingSpace, signal)
    const indexer = new ProjectIndexer(cwd, embedder, store)
    return {
      indexer,
      store,
      embeddingModel: config.embeddingModel,
      embeddingSpace,
    }
  }
  catch (err)
  {
    store?.close?.()
    throw new RetrievalBuildError(embeddingModel, err)
  }
}
