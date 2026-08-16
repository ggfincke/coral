// src/inference/resolve-client.ts
// composition-root helper: ModelRef + deps -> AgentInferenceClient

import type { AgentInferenceClient } from '../agent/inference-client.js'
import { formatWorkerInstallError } from '../config/inference.js'
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelInfo,
} from '../types/inference.js'
import { toErrorMessage } from '../utils/errors.js'
import {
  canonicalListedName,
  remainderForBackend,
  type InferenceBackend,
  type ModelRef,
} from './model-ref.js'
import { PythonInferenceClient } from './python-client.js'
import type { WorkerSupervisor } from './worker-supervisor.js'

export interface InferenceClientDependencies
{
  ollama: AgentInferenceClient
  worker?: WorkerSupervisor
}

/**
 * Rewrites canonical model strings to the remainder a backend client expects.
 */
class RemainderInferenceClient implements AgentInferenceClient
{
  constructor(
    private readonly inner: AgentInferenceClient,
    private readonly backend: InferenceBackend
  )
  {}

  startKeepAlive(model: string): void
  {
    this.inner.startKeepAlive(remainderForBackend(model, this.backend))
  }

  showModel(model: string, signal?: AbortSignal): Promise<ModelInfo>
  {
    return this.inner.showModel(
      remainderForBackend(model, this.backend),
      signal
    )
  }

  async listModels(signal?: AbortSignal): Promise<Model[]>
  {
    const models = await this.inner.listModels(signal)
    return models.map((entry) => ({
      ...entry,
      name: canonicalListedName(entry.name, this.backend),
    }))
  }

  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatResponse>
  {
    yield* this.inner.chatStream(
      {
        ...request,
        model: remainderForBackend(request.model, this.backend),
      },
      signal
    )
  }
}

export function resolveInferenceClient(
  ref: ModelRef,
  deps: InferenceClientDependencies
): AgentInferenceClient
{
  if (ref.backend === 'ollama')
  {
    return new RemainderInferenceClient(deps.ollama, 'ollama')
  }
  if (!deps.worker)
  {
    throw new Error(formatWorkerInstallError())
  }
  return new PythonInferenceClient(deps.worker, ref)
}

export interface AvailableModelList
{
  models: Model[]
  warning?: string
}

export async function listAvailableModels(
  deps: InferenceClientDependencies,
  signal?: AbortSignal
): Promise<AvailableModelList>
{
  const models: Model[] = []
  const warnings: string[] = []
  const ollama = new RemainderInferenceClient(deps.ollama, 'ollama')
  const ollamaModels = ollama.listModels(signal)
  const mlxModels = (async (): Promise<Model[]> =>
  {
    if (!deps.worker)
    {
      throw new Error(formatWorkerInstallError())
    }
    if (!deps.worker.isLaunchable())
    {
      throw new Error(deps.worker.launchErrorMessage())
    }
    await deps.worker.ensure(signal)
    const mlx = new PythonInferenceClient(deps.worker, {
      backend: 'mlx',
      model: '_',
      canonical: 'mlx:_',
    })
    return mlx.listModels(signal)
  })()

  const [ollamaResult, mlxResult] = await Promise.allSettled([
    ollamaModels,
    mlxModels,
  ])
  signal?.throwIfAborted()

  if (ollamaResult.status === 'fulfilled')
  {
    models.push(...ollamaResult.value)
  }
  else warnings.push(`Ollama: ${toErrorMessage(ollamaResult.reason)}`)

  if (mlxResult.status === 'fulfilled') models.push(...mlxResult.value)
  else warnings.push(`mlx: ${toErrorMessage(mlxResult.reason)}`)

  if (models.length === 0 && warnings.length > 0)
  {
    throw new Error(warnings.join('\n'))
  }

  const result: AvailableModelList = { models }
  if (warnings.length > 0) result.warning = warnings.join('\n')
  return result
}
