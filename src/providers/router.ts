// src/providers/router.ts
// route Agent inference to Ollama or a hosted API by model ref

import type { AgentInferenceClient } from '../agent/inference-client.js'
import { OllamaClient } from '../ollama/client.js'
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelInfo,
} from '../types/inference.js'
import { hasHostedCredentials, resolveHostedSettings } from './config.js'
import {
  formatModelRef,
  HOSTED_PROVIDERS,
  parseModelRef,
  type HostedProvider,
} from './model-ref.js'

export type HostedClientLoader = () => Promise<AgentInferenceClient>

// load each SDK only when a hosted model is first used so Ollama-only runs
// never import it
const DEFAULT_LOADERS: Record<HostedProvider, HostedClientLoader> = {
  anthropic: async () =>
  {
    const { AnthropicClient } = await import('./anthropic/client.js')
    return new AnthropicClient(resolveHostedSettings('anthropic'))
  },
}

export interface RoutingInferenceClientOptions
{
  ollama?: AgentInferenceClient
  loaders?: Partial<Record<HostedProvider, HostedClientLoader>>
  // credential probe seam for tests; production reads the environment
  hasCredentials?: (provider: HostedProvider) => boolean
}

/**
 * Inference client that dispatches each call by its model ref. Bare model
 * strings stay on Ollama; `anthropic/` refs go to lazily constructed
 * hosted clients that receive the unprefixed native name.
 */
export class RoutingInferenceClient implements AgentInferenceClient
{
  private readonly ollama: AgentInferenceClient
  private readonly loaders: Record<HostedProvider, HostedClientLoader>
  private readonly hasCredentials: (provider: HostedProvider) => boolean
  private readonly hosted = new Map<
    HostedProvider,
    Promise<AgentInferenceClient>
  >()

  constructor(
    ollamaHost?: string,
    options: RoutingInferenceClientOptions = {}
  )
  {
    this.ollama = options.ollama ?? new OllamaClient(ollamaHost)
    this.loaders = { ...DEFAULT_LOADERS, ...options.loaders }
    this.hasCredentials = options.hasCredentials ?? hasHostedCredentials
  }

  // share one construction per provider and retry after a failed load
  private hostedClient(
    provider: HostedProvider
  ): Promise<AgentInferenceClient>
  {
    let pending = this.hosted.get(provider)
    if (!pending)
    {
      pending = this.loaders[provider]()
      pending.catch(() =>
      {
        if (this.hosted.get(provider) === pending) this.hosted.delete(provider)
      })
      this.hosted.set(provider, pending)
    }
    return pending
  }

  startKeepAlive(model: string): void
  {
    const ref = parseModelRef(model)
    if (ref.provider === 'ollama') this.ollama.startKeepAlive(ref.name)
  }

  async showModel(model: string, signal?: AbortSignal): Promise<ModelInfo>
  {
    const ref = parseModelRef(model)
    if (ref.provider === 'ollama') return this.ollama.showModel(model, signal)
    const client = await this.hostedClient(ref.provider)
    return client.showModel(ref.name, signal)
  }

  // list every reachable backend; one failing backend only hides its models
  async listModels(signal?: AbortSignal): Promise<Model[]>
  {
    const providers = HOSTED_PROVIDERS.filter(this.hasCredentials)
    const results = await Promise.allSettled([
      this.ollama.listModels(signal),
      ...providers.map(async (provider) =>
      {
        const client = await this.hostedClient(provider)
        const models = await client.listModels(signal)
        return models.map((model) => ({
          ...model,
          name: formatModelRef(provider, model.name),
        }))
      }),
    ])
    signal?.throwIfAborted()

    const models: Model[] = []
    const errors: unknown[] = []
    for (const result of results)
    {
      if (result.status === 'fulfilled') models.push(...result.value)
      else errors.push(result.reason)
    }
    if (errors.length === results.length) throw errors[0]
    return models
  }

  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatResponse>
  {
    const ref = parseModelRef(request.model)
    if (ref.provider === 'ollama')
    {
      yield* this.ollama.chatStream(request, signal)
      return
    }
    const client = await this.hostedClient(ref.provider)
    yield* client.chatStream({ ...request, model: ref.name }, signal)
  }
}

// the one production factory for chat inference; embeddings stay on Ollama
export function createInferenceClient(
  ollamaHost?: string
): RoutingInferenceClient
{
  return new RoutingInferenceClient(ollamaHost)
}
