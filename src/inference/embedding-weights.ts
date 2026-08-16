// src/inference/embedding-weights.ts
// dual-residency extra weight bytes for a separately resident embedding model

import type { Model } from '../types/inference.js'
import { ollamaModelLookupKey } from '../utils/ollama-model.js'
import { parseModelRef, type InferenceBackend } from './model-ref.js'
import type { WorkerSupervisor } from './worker-supervisor.js'

function listedSize(models: Model[], requested: string): number
{
  const match = models.find(
    (candidate) => candidate.name === requested || candidate.model === requested
  )
  const size = match?.size
  return typeof size === 'number' && Number.isFinite(size) && size > 0
    ? size
    : 0
}

function listedOllamaSize(models: Model[], requested: string): number
{
  const requestedKey = ollamaModelLookupKey(requested)
  const matches = models.filter((candidate) =>
    [candidate.name, candidate.model].some(
      (name) =>
        typeof name === 'string' && ollamaModelLookupKey(name) === requestedKey
    )
  )
  if (matches.length !== 1) return 0
  const size = matches[0]?.size
  return typeof size === 'number' && Number.isFinite(size) && size > 0
    ? size
    : 0
}

// count embedding-model weights when they stay loaded beside chat (not when
// both use the same Ollama model identity or the same mlx checkpoint)
export async function resolveDualResidencyWeightBytes(options: {
  chatBackend: InferenceBackend
  chatModel?: string
  embedModel: string
  listOllamaModels: (signal?: AbortSignal) => Promise<Model[]>
  worker?: WorkerSupervisor
  signal?: AbortSignal
}): Promise<number>
{
  const embedRef = parseModelRef(options.embedModel)
  if (
    options.chatBackend === 'ollama' &&
    embedRef.backend === 'ollama' &&
    options.chatModel !== undefined &&
    ollamaModelLookupKey(options.chatModel) ===
      ollamaModelLookupKey(embedRef.model)
  )
  {
    return 0
  }
  if (
    options.chatBackend === 'mlx' &&
    embedRef.backend === 'mlx' &&
    options.chatModel !== undefined &&
    (embedRef.model === options.chatModel ||
      embedRef.canonical === options.chatModel)
  )
  {
    return 0
  }
  if (embedRef.backend === 'mlx')
  {
    if (!options.worker) return 0
    await options.worker.ensure(options.signal)
    const payload = await options.worker.request(
      'model.list',
      {},
      options.signal
    )
    const models = Array.isArray(payload.models)
      ? (payload.models as Model[])
      : []
    return (
      listedSize(models, embedRef.model) ||
      listedSize(models, embedRef.canonical)
    )
  }
  const models = await options.listOllamaModels(options.signal)
  return listedOllamaSize(models, embedRef.model)
}
