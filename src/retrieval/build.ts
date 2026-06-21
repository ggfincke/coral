// src/retrieval/build.ts
// shared construction of the embedder-backed project indexer

import { OllamaClient } from '../ollama/client.js'
import { resolveRetrievalConfig } from '../config/retrieval.js'
import { ProjectIndexer } from './indexer.js'
import { OllamaEmbedder } from './ollama-embedder.js'
import { SqliteIndexStore } from './sqlite-store.js'
import type { IndexStore } from './types.js'

// swappable construction seams for tests
export interface RetrievalDeps
{
  createStore?: () => IndexStore
  createClient?: (ollamaHost: string) => OllamaClient
}

export interface BuiltIndexer
{
  indexer: ProjectIndexer
  store: IndexStore
  embeddingModel: string
}

// wire up store + client + embedder + indexer for a project. caller owns the
// returned store & must close it; on construction failure the store is closed
export function buildIndexer(
  cwd: string,
  ollamaHost: string,
  signal?: AbortSignal,
  deps: RetrievalDeps = {}
): BuiltIndexer
{
  const config = resolveRetrievalConfig(cwd)
  const store = deps.createStore?.() ?? new SqliteIndexStore()

  try
  {
    const client =
      deps.createClient?.(ollamaHost) ?? new OllamaClient(ollamaHost)
    const embedder = new OllamaEmbedder(client, config.embeddingModel, signal)
    const indexer = new ProjectIndexer(cwd, embedder, store)
    return { indexer, store, embeddingModel: config.embeddingModel }
  }
  catch (err)
  {
    store.close?.()
    throw err
  }
}
