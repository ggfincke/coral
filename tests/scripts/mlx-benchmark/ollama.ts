// tests/scripts/mlx-benchmark/ollama.ts
// benchmark-only Ollama adapter with exact deterministic sampling inputs

import type { AgentInferenceClient } from '../../../src/agent/inference-client.js'
import { OllamaClient } from '../../../src/ollama/client.js'
import type {
  ChatRequest,
  ChatResponse,
  ModelRequestMessage,
  OllamaTool,
  OllamaToolCall,
} from '../../../src/types/inference.js'
import type { OllamaRunningModelIdentity } from './types.js'

const MAX_ERROR_BYTES = 64 * 1024
const EVICTION_POLL_INTERVAL_MS = 100

export interface PinnedSampling
{
  temperature: 0
  topP: 1
}

function wireToolCall(call: OllamaToolCall): OllamaToolCall
{
  return {
    ...(call.type === undefined ? {} : { type: call.type }),
    function: {
      ...(call.function.index === undefined
        ? {}
        : { index: call.function.index }),
      name: call.function.name,
      arguments: { ...call.function.arguments },
    },
  }
}

function wireMessage(message: ModelRequestMessage): ModelRequestMessage
{
  return {
    role: message.role,
    content: message.content,
    ...(message.thinking === undefined ? {} : { thinking: message.thinking }),
    ...(message.tool_name === undefined
      ? {}
      : { tool_name: message.tool_name }),
    ...(message.tool_calls === undefined
      ? {}
      : { tool_calls: message.tool_calls.map(wireToolCall) }),
  }
}

// match the production transport's leading-system normalization exactly
function wireMessages(messages: ModelRequestMessage[]): ModelRequestMessage[]
{
  const wired = messages.map(wireMessage)
  const systemMessages = wired.filter((message) => message.role === 'system')
  if (systemMessages.length === 0) return wired
  return [
    {
      role: 'system',
      content: systemMessages.map((message) => message.content).join('\n\n'),
    },
    ...wired.filter((message) => message.role !== 'system'),
  ]
}

function wireTool(tool: OllamaTool): OllamaTool
{
  return {
    type: 'function',
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }
}

function normalizedSha256(value: unknown, label: string): string
{
  if (typeof value !== 'string')
  {
    throw new Error(`${label} was not a string`)
  }
  const match = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value)
  if (!match?.[1]) throw new Error(`${label} was not a SHA-256 digest`)
  return match[1].toLowerCase()
}

// fail closed when Ollama cannot prove which exact artifacts remain resident
function runningModelIdentities(value: unknown): OllamaRunningModelIdentity[]
{
  if (typeof value !== 'object' || value === null || Array.isArray(value))
  {
    throw new Error('Ollama /api/ps returned a non-object')
  }
  const models = (value as Record<string, unknown>).models
  if (!Array.isArray(models))
  {
    throw new Error('Ollama /api/ps omitted its models array')
  }
  return models.map((value, index) =>
  {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
    {
      throw new Error(`Ollama /api/ps model ${index} was not an object`)
    }
    const model = value as Record<string, unknown>
    if (
      typeof model.name !== 'string' ||
      model.name.length === 0 ||
      typeof model.model !== 'string' ||
      model.model.length === 0
    )
    {
      throw new Error(
        `Ollama /api/ps model ${index} omitted name or model identity`
      )
    }
    return {
      name: model.name,
      model: model.model,
      digest: normalizedSha256(
        model.digest,
        `Ollama /api/ps model ${index} digest`
      ),
    }
  })
}

function assertUnloadResponse(value: unknown, expectedModel: string): void
{
  if (typeof value !== 'object' || value === null || Array.isArray(value))
  {
    throw new Error('Ollama eviction returned a non-object')
  }
  const response = value as Record<string, unknown>
  if (
    response.done !== true ||
    response.done_reason !== 'unload' ||
    response.model !== expectedModel
  )
  {
    throw new Error('Ollama eviction response did not confirm the exact unload')
  }
}

function deadlineSignal(deadline: number): AbortSignal
{
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) throw new Error('Ollama eviction deadline expired')
  return AbortSignal.timeout(remainingMs)
}

function delay(ms: number): Promise<void>
{
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function listRunningModels(
  baseUrl: string,
  deadline: number
): Promise<OllamaRunningModelIdentity[]>
{
  const response = await fetch(`${baseUrl}/api/ps`, {
    signal: deadlineSignal(deadline),
  })
  if (!response.ok)
  {
    throw new Error(`Ollama residency probe returned HTTP ${response.status}`)
  }
  return runningModelIdentities(await response.json())
}

function exactModelPresent(
  models: OllamaRunningModelIdentity[],
  model: string,
  expectedDigest: string
): boolean
{
  const driftedName = models.find(
    (identity) =>
      (identity.name === model || identity.model === model) &&
      identity.digest !== expectedDigest
  )
  if (driftedName)
  {
    throw new Error(
      `Ollama running-model identity drifted for ${model}: ${driftedName.digest}`
    )
  }
  return models.some(
    (identity) =>
      identity.name === model ||
      identity.model === model ||
      identity.digest === expectedDigest
  )
}

export class PinnedOllamaClient implements AgentInferenceClient
{
  private readonly baseUrl: string
  private readonly inner: OllamaClient

  constructor(
    host: string,
    private readonly sampling: PinnedSampling
  )
  {
    this.baseUrl = host.replace(/\/+$/, '')
    const url = new URL(this.baseUrl)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    {
      throw new Error(
        'the benchmark Ollama adapter requires exact HTTP loopback 127.0.0.1'
      )
    }
    this.inner = new OllamaClient(host)
  }

  startKeepAlive(model: string): void
  {
    this.inner.startKeepAlive(model)
  }

  showModel(model: string, signal?: AbortSignal)
  {
    return this.inner.showModel(model, signal)
  }

  listModels(signal?: AbortSignal)
  {
    return this.inner.listModels(signal)
  }

  async evictModel(
    model: string,
    revision: string,
    timeoutMs: number
  ): Promise<OllamaRunningModelIdentity[]>
  {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    {
      throw new Error('Ollama eviction timeout must be a positive integer')
    }
    const deadline = Date.now() + timeoutMs
    const expectedDigest = normalizedSha256(revision, 'Ollama model revision')
    let identities = await listRunningModels(this.baseUrl, deadline)
    if (!exactModelPresent(identities, model, expectedDigest)) return identities
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [],
        keep_alive: 0,
        stream: false,
        options: { num_predict: 0 },
      }),
      signal: deadlineSignal(deadline),
    })
    if (!response.ok)
    {
      throw new Error(`Ollama eviction returned HTTP ${response.status}`)
    }
    assertUnloadResponse(await response.json(), model)

    while (true)
    {
      identities = await listRunningModels(this.baseUrl, deadline)
      if (!exactModelPresent(identities, model, expectedDigest))
        return identities
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0)
      {
        throw new Error(
          `Ollama model remained resident after eviction: ${model}`
        )
      }
      await delay(Math.min(EVICTION_POLL_INTERVAL_MS, remainingMs))
    }
  }

  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatResponse>
  {
    const options: Record<string, number> = {
      temperature: this.sampling.temperature,
      top_p: this.sampling.topP,
    }
    if (request.num_ctx !== undefined) options.num_ctx = request.num_ctx
    if (request.num_predict !== undefined)
    {
      options.num_predict = request.num_predict
    }
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: wireMessages(request.messages),
        ...(request.tools === undefined
          ? {}
          : { tools: request.tools.map(wireTool) }),
        ...(request.think === undefined ? {} : { think: request.think }),
        keep_alive: request.keep_alive ?? '10m',
        stream: true,
        options,
      }),
      signal,
    })
    if (!response.ok)
    {
      const detail = (await response.text()).slice(0, MAX_ERROR_BYTES)
      throw new Error(`pinned Ollama HTTP ${response.status}: ${detail}`)
    }
    if (!response.body) throw new Error('pinned Ollama response had no body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    try
    {
      while (true)
      {
        const { done, value } = await reader.read()
        buffered += decoder.decode(value, { stream: !done })
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines)
        {
          if (line.trim()) yield JSON.parse(line) as ChatResponse
        }
        if (done) break
      }
      if (buffered.trim()) yield JSON.parse(buffered) as ChatResponse
    }
    finally
    {
      await reader.cancel()
    }
  }
}
