// src/retrieval/config.ts
// semantic retrieval configuration

import { loadProjectConfig } from '../config/project-config.js'
import { DEFAULT_EMBEDDING_MODEL } from './types.js'
import { isPlainObject } from '../utils/guards.js'

export interface RetrievalConfig
{
  embeddingModel: string
}

export function resolveRetrievalConfig(cwd: string): RetrievalConfig
{
  const raw = loadProjectConfig(cwd).retrieval
  const configured =
    isPlainObject(raw) && typeof raw.embeddingModel === 'string'
      ? raw.embeddingModel.trim()
      : ''
  const env = process.env.CORAL_EMBEDDING_MODEL?.trim()

  return {
    embeddingModel: env || configured || DEFAULT_EMBEDDING_MODEL,
  }
}
