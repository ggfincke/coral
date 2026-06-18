// src/config/retrieval.ts
// semantic retrieval config

import { loadProjectConfig } from './project-config.js'
import { DEFAULT_EMBEDDING_MODEL } from '../retrieval/types.js'

export interface RetrievalConfig
{
  embeddingModel: string
}

export function resolveRetrievalConfig(cwd: string): RetrievalConfig
{
  const config = loadProjectConfig(cwd).retrieval
  const configured =
    typeof config?.embeddingModel === 'string'
      ? config.embeddingModel.trim()
      : ''
  const env = process.env.CORAL_EMBEDDING_MODEL?.trim()

  return {
    embeddingModel: env || configured || DEFAULT_EMBEDDING_MODEL,
  }
}
