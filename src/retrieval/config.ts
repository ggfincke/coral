// src/retrieval/config.ts
// semantic retrieval configuration

import { loadProjectConfig } from '../config/project-config.js'
import { DEFAULT_EMBEDDING_MODEL, type EmbeddingProvider } from './types.js'
import { isPlainObject } from '../utils/guards.js'

export interface RetrievalConfig
{
  embeddingModel: string
  provider: EmbeddingProvider
}

function configuredProvider(value: string): EmbeddingProvider | undefined
{
  return value === 'mlx' || value === 'ollama' ? value : undefined
}

function explicitModelProvider(value: string): EmbeddingProvider | undefined
{
  if (value.startsWith('mlx:')) return 'mlx'
  if (value.startsWith('ollama:')) return 'ollama'
  return undefined
}

function normalizedRetrievalConfig(
  modelValue: string,
  providerValue = ''
): RetrievalConfig
{
  const model = modelValue.trim()
  const explicit = explicitModelProvider(model)
  const configured = configuredProvider(providerValue)
  if (explicit && configured && explicit !== configured)
  {
    throw new Error(
      `retrieval provider ${configured} conflicts with embedding model ${model}`
    )
  }

  const provider = explicit ?? configured ?? 'ollama'
  const prefix = explicit ? `${explicit}:` : ''
  const name = prefix ? model.slice(prefix.length).trim() : model
  if (!name)
  {
    throw new Error(`${provider} embedding model must be nonempty`)
  }
  return { provider, embeddingModel: `${provider}:${name}` }
}

export function canonicalEmbeddingModel(config: RetrievalConfig): string
{
  const { provider, name } = embeddingBackendName(config)
  return `${provider}:${name}`
}

export function embeddingBackendName(config: RetrievalConfig): {
  provider: EmbeddingProvider
  name: string
}
{
  const model = config.embeddingModel
  const explicit = explicitModelProvider(model)
  if (explicit && explicit !== config.provider)
  {
    throw new Error(
      `retrieval provider ${config.provider} conflicts with embedding model ${model}`
    )
  }
  const prefix = explicit ? `${explicit}:` : ''
  const name = (prefix ? model.slice(prefix.length) : model).trim()
  if (!name)
    throw new Error(`${config.provider} embedding model must be nonempty`)
  return { provider: config.provider, name }
}

export function resolveRetrievalConfig(cwd: string): RetrievalConfig
{
  const raw = loadProjectConfig(cwd).retrieval
  const object = isPlainObject(raw) ? raw : {}
  const configured =
    typeof object.embeddingModel === 'string'
      ? object.embeddingModel.trim()
      : ''
  const providerRaw =
    typeof object.provider === 'string' ? object.provider.trim() : ''
  const env = process.env.CORAL_EMBEDDING_MODEL?.trim()
  if (env) return normalizedRetrievalConfig(env)
  return normalizedRetrievalConfig(
    configured || DEFAULT_EMBEDDING_MODEL,
    providerRaw
  )
}
