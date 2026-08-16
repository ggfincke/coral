// src/inference/python-client.ts
// map worker protocol frames onto AgentInferenceClient ChatResponse

import type { AgentInferenceClient } from '../agent/inference-client.js'
import {
  isChatProtocol,
  isModelProtocol,
  type Envelope,
} from '../protocol/index.js'
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelInfo,
  OllamaToolCall,
} from '../types/inference.js'
import { isPlainObject } from '../utils/guards.js'
import {
  canonicalListedName,
  remainderForBackend,
  type ModelRef,
} from './model-ref.js'
import type { WorkerSupervisor } from './worker-supervisor.js'

function asModelInfo(payload: Record<string, unknown>): ModelInfo
{
  if (!isModelProtocol(payload) || typeof payload.contextLength !== 'number')
  {
    throw new Error('worker model.show result was not a ModelInfo payload')
  }
  const info: ModelInfo = { contextLength: payload.contextLength }
  if (typeof payload.architecture === 'string')
  {
    info.architecture = payload.architecture
  }
  if (typeof payload.blockCount === 'number')
    info.blockCount = payload.blockCount
  if (typeof payload.kvHeadCount === 'number')
  {
    info.kvHeadCount = payload.kvHeadCount
  }
  if (typeof payload.keyLength === 'number') info.keyLength = payload.keyLength
  if (typeof payload.valueLength === 'number')
  {
    info.valueLength = payload.valueLength
  }
  if (typeof payload.size === 'number') info.size = payload.size
  if (typeof payload.digest === 'string') info.digest = payload.digest
  return info
}

function asModelList(payload: Record<string, unknown>): Model[]
{
  const raw = payload.models
  if (!Array.isArray(raw))
  {
    throw new Error('worker model.list result did not include a models array')
  }
  return raw.map((entry, index) =>
  {
    if (
      !isPlainObject(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.size !== 'number' ||
      typeof entry.modified_at !== 'string'
    )
    {
      throw new Error(`worker model.list entry ${index} was invalid`)
    }
    const model: Model = {
      name: entry.name,
      size: entry.size,
      modified_at: entry.modified_at,
    }
    if (typeof entry.model === 'string') model.model = entry.model
    if (typeof entry.digest === 'string') model.digest = entry.digest
    return model
  })
}

function mapToolCalls(value: unknown): OllamaToolCall[] | undefined
{
  if (!Array.isArray(value)) return undefined
  return value.map((entry) =>
  {
    if (!isPlainObject(entry) || !isPlainObject(entry.function))
    {
      throw new Error('worker chat event included an invalid tool call')
    }
    const fn = entry.function
    if (typeof fn.name !== 'string' || !isPlainObject(fn.arguments))
    {
      throw new Error('worker chat event included an invalid tool call')
    }
    const call: OllamaToolCall = {
      function: {
        name: fn.name,
        arguments: { ...fn.arguments },
      },
    }
    if (entry.type === 'function') call.type = 'function'
    if (typeof fn.index === 'number') call.function.index = fn.index
    return call
  })
}

function mapChatResponse(payload: Record<string, unknown>): ChatResponse
{
  if (!isChatProtocol(payload) || typeof payload.done !== 'boolean')
  {
    throw new Error('worker chat event was not a ChatResponse payload')
  }
  if (!('message' in payload) || !isPlainObject(payload.message))
  {
    throw new Error('worker chat event was not a ChatResponse payload')
  }
  const message = payload.message
  const role = message.role
  if (
    role !== 'assistant' &&
    role !== 'system' &&
    role !== 'user' &&
    role !== 'tool'
  )
  {
    throw new Error('worker chat event was not a ChatResponse payload')
  }
  const mapped: ChatResponse = {
    message: {
      role,
      content: typeof message.content === 'string' ? message.content : '',
    },
    done: payload.done,
  }
  if (typeof message.thinking === 'string')
  {
    mapped.message.thinking = message.thinking
  }
  if (typeof message.tool_name === 'string')
  {
    mapped.message.tool_name = message.tool_name
  }
  const toolCalls = mapToolCalls(message.tool_calls)
  if (toolCalls) mapped.message.tool_calls = toolCalls
  if (typeof payload.prompt_eval_count === 'number')
  {
    mapped.prompt_eval_count = payload.prompt_eval_count
  }
  if (typeof payload.prompt_eval_duration === 'number')
  {
    mapped.prompt_eval_duration = payload.prompt_eval_duration
  }
  if (typeof payload.eval_count === 'number')
  {
    mapped.eval_count = payload.eval_count
  }
  if (typeof payload.eval_duration === 'number')
  {
    mapped.eval_duration = payload.eval_duration
  }
  return mapped
}

function mlxRemainder(model: string): string
{
  return remainderForBackend(model, 'mlx')
}

/**
 * Inference adapter that talks to the Coral Python worker over stdio.
 */
export class PythonInferenceClient implements AgentInferenceClient
{
  private keepAliveModel: string

  constructor(
    private readonly worker: WorkerSupervisor,
    initial: ModelRef
  )
  {
    if (initial.backend !== 'mlx')
    {
      throw new Error(
        `PythonInferenceClient requires an mlx model ref, got ${initial.canonical}`
      )
    }
    this.keepAliveModel = initial.model
  }

  startKeepAlive(model: string): void
  {
    this.keepAliveModel = mlxRemainder(model)
  }

  async showModel(model: string, signal?: AbortSignal): Promise<ModelInfo>
  {
    const payload = await this.worker.request(
      'model.show',
      { name: mlxRemainder(model) },
      signal
    )
    return asModelInfo(payload)
  }

  async listModels(signal?: AbortSignal): Promise<Model[]>
  {
    const payload = await this.worker.request('model.list', {}, signal)
    return asModelList(payload).map((entry) => ({
      ...entry,
      name: canonicalListedName(entry.name, 'mlx'),
      model: entry.model ?? entry.name,
    }))
  }

  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatResponse>
  {
    const model = mlxRemainder(request.model)
    this.keepAliveModel = model
    const payload = {
      model,
      messages: request.messages,
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.think !== undefined ? { think: request.think } : {}),
      ...(request.keep_alive !== undefined
        ? { keep_alive: request.keep_alive }
        : {}),
      ...(request.num_ctx !== undefined ? { num_ctx: request.num_ctx } : {}),
      ...(request.num_predict !== undefined
        ? { num_predict: request.num_predict }
        : {}),
    }

    for await (const envelope of this.worker.stream(
      'chat.start',
      payload,
      signal
    ))
    {
      yield* this.framesToChunks(envelope)
    }
  }

  recordedKeepAliveModel(): string
  {
    return this.keepAliveModel
  }

  private *framesToChunks(envelope: Envelope): Generator<ChatResponse>
  {
    if (envelope.kind === 'error')
    {
      const message = envelope.payload.message
      throw new Error(
        typeof message === 'string' && message
          ? message
          : 'Python worker chat request failed'
      )
    }
    if (envelope.kind === 'event' || envelope.kind === 'result')
    {
      if (!isPlainObject(envelope.payload)) return
      if (typeof envelope.payload.done !== 'boolean')
      {
        if (envelope.kind === 'result') return
        throw new Error('worker chat event was not a ChatResponse payload')
      }
      yield mapChatResponse(envelope.payload)
    }
  }
}
