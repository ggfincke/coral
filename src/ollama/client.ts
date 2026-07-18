// src/ollama/client.ts
// streaming chat client for the Ollama REST API

import type {
  ChatRequest,
  ChatResponse,
  EmbedResponse,
  Model,
  ModelInfo,
  ModelRequestMessage,
  OllamaTool,
  OllamaToolCall,
} from '../types/inference.js'
import { DEFAULT_OLLAMA_HOST, normalizeOllamaHost } from './host.js'
import { OllamaApiError, OllamaModelIdentityError } from './errors.js'
import { toErrorMessage } from '../utils/errors.js'

const DEFAULT_KEEP_ALIVE = '10m'
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const
const THINK_FALLBACK_STATUS = new Set([400, 404, 422])
type ThinkSupport = 'unknown' | 'supported' | 'unsupported'

export interface OllamaModelArtifact
{
  model: string
  digest: string
}

type ChatMessage = ChatRequest['messages'][number]

interface JsonRequestOptions
{
  method?: string
  body?: unknown
  signal?: AbortSignal
}

function throwApiError(status: number, body: string): never
{
  throw new OllamaApiError(status, body)
}

function formatConnectionError(baseUrl: string, detail: string): string
{
  return `Cannot reach Ollama at ${baseUrl}: ${detail}`
}

function wireToolCall(call: OllamaToolCall): OllamaToolCall
{
  const projected: OllamaToolCall = {
    function: {
      name: call.function.name,
      arguments: { ...call.function.arguments },
    },
  }

  if (call.type !== undefined) projected.type = call.type
  if (call.function.index !== undefined)
  {
    projected.function.index = call.function.index
  }
  return projected
}

// reconstruct the transport shape so persisted and UI-only fields cannot cross
// the final fetch boundary through a structural cast
function wireMessage(message: ChatMessage): ModelRequestMessage
{
  const projected: ModelRequestMessage = {
    role: message.role,
    content: message.content,
  }

  if (message.thinking !== undefined) projected.thinking = message.thinking
  if (message.tool_name !== undefined) projected.tool_name = message.tool_name
  if (message.tool_calls !== undefined)
  {
    projected.tool_calls = message.tool_calls.map(wireToolCall)
  }
  return projected
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

// match the shortest names returned by /api/tags while preserving custom hosts
function modelLookupKey(model: string): string
{
  let key = model.trim().replace(/^https?:\/\//i, '')
  key = key.replace(/^registry\.ollama\.ai\/library\//i, '')
  key = key.replace(/^library\//i, '')

  if (key.lastIndexOf(':') <= key.lastIndexOf('/'))
  {
    key += ':latest'
  }

  return key.toLowerCase()
}

function normalizedArtifactDigest(digest: unknown): string | null
{
  if (typeof digest !== 'string') return null
  const match = digest.trim().match(/^(?:sha256:)?([a-f\d]{64})$/i)
  return match?.[1]?.toLowerCase() ?? null
}

// read an exact numeric key from an Ollama model_info map
function numAt(info: Record<string, unknown>, key: string): number | undefined
{
  const val = info[key]
  return typeof val === 'number' ? val : undefined
}

// fall back to a context_length key while skipping training-time caps
function scanContextLength(info: Record<string, unknown>): number
{
  for (const [key, val] of Object.entries(info))
  {
    if (
      key.endsWith('.context_length') &&
      !key.includes('original') &&
      typeof val === 'number'
    )
    {
      return val
    }
  }
  return 0
}

// * Ollama REST API client
export class OllamaClient
{
  private baseUrl: string
  private lastModel: string | null = null
  private thinkSupportByModel = new Map<string, ThinkSupport>()

  constructor(baseUrl = DEFAULT_OLLAMA_HOST)
  {
    this.baseUrl = normalizeOllamaHost(baseUrl)
  }

  // identify whether the server rejected the think field specifically
  private shouldRetryWithoutThink(status: number, errorText: string): boolean
  {
    if (!THINK_FALLBACK_STATUS.has(status)) return false

    const normalized = errorText.toLowerCase()
    // retry only when the error clearly references the think field
    return normalized.includes('think') || normalized.includes('unknown field')
  }

  // build a /api/chat payload and optionally omit think
  private buildChatBody(
    request: ChatRequest,
    includeThink: boolean
  ): Record<string, unknown>
  {
    // ! never add `format` to tool-bearing requests because Ollama drops tool_calls
    // place num_ctx under options because the top-level field is only a convenience
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(wireMessage),
      keep_alive: request.keep_alive ?? DEFAULT_KEEP_ALIVE,
      stream: true,
    }

    if (request.tools !== undefined)
    {
      body.tools = request.tools.map(wireTool)
    }
    if (includeThink && request.think !== undefined)
    {
      body.think = request.think
    }

    const options: Record<string, number> = {}
    if (typeof request.num_ctx === 'number' && request.num_ctx > 0)
    {
      options.num_ctx = request.num_ctx
    }
    if (typeof request.num_predict === 'number' && request.num_predict > 0)
    {
      options.num_predict = request.num_predict
    }
    if (Object.keys(options).length > 0) body.options = options

    return body
  }

  // read cached think capability for one model
  private getThinkSupport(model: string): ThinkSupport
  {
    return this.thinkSupportByModel.get(model) ?? 'unknown'
  }

  // cache think capability for one model
  private setThinkSupport(model: string, support: ThinkSupport): void
  {
    this.thinkSupportByModel.set(model, support)
  }

  // post a chat body and translate dropped-socket failures into an actionable error
  private async chatFetch(
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Response>
  {
    try
    {
      return await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        signal,
      })
    }
    catch (err)
    {
      if (signal?.aborted) throw err
      const detail = toErrorMessage(err)
      throw new Error(
        `${formatConnectionError(this.baseUrl, detail)} - the server may be down, or ` +
          `the request may have exceeded the model's context or memory`
      )
    }
  }

  // fetch a non-streaming JSON endpoint with shared error handling
  private async jsonRequest<T>(
    path: string,
    options: JsonRequestOptions = {}
  ): Promise<T>
  {
    const init: RequestInit = {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: JSON_HEADERS,
      signal: options.signal,
    }

    if (options.body !== undefined)
    {
      init.body = JSON.stringify(options.body)
    }

    let res: Response
    try
    {
      res = await fetch(`${this.baseUrl}${path}`, init)
    }
    catch (err)
    {
      if (options.signal?.aborted) throw err
      throw new Error(formatConnectionError(this.baseUrl, toErrorMessage(err)))
    }

    if (!res.ok) throwApiError(res.status, await res.text())
    return (await res.json()) as T
  }

  // open a chat stream and fall back when think is unsupported
  private async postChat(
    request: ChatRequest,
    signal?: AbortSignal
  ): Promise<Response>
  {
    const thinkSupport = this.getThinkSupport(request.model)
    const includeThink =
      request.think !== undefined &&
      request.think !== false &&
      thinkSupport !== 'unsupported'
    const initial = await this.chatFetch(
      this.buildChatBody(request, includeThink),
      signal
    )

    if (initial.ok)
    {
      if (includeThink)
      {
        this.setThinkSupport(request.model, 'supported')
      }
      return initial
    }

    if (!includeThink)
    {
      throwApiError(initial.status, await initial.text())
    }

    const initialError = await initial.text()
    if (!this.shouldRetryWithoutThink(initial.status, initialError))
    {
      throwApiError(initial.status, initialError)
    }

    this.setThinkSupport(request.model, 'unsupported')

    const retry = await this.chatFetch(
      this.buildChatBody(request, false),
      signal
    )

    if (!retry.ok)
    {
      throwApiError(retry.status, await retry.text())
    }

    return retry
  }

  // remember the active model for explicit eviction callers
  startKeepAlive(model: string): void
  {
    this.lastModel = model
  }

  // explicitly evict a model from the shared Ollama host
  async evictModel(model = this.lastModel): Promise<void>
  {
    if (!model) return

    try
    {
      await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          model,
          messages: [],
          keep_alive: 0,
          stream: false,
          options: { num_predict: 0 },
        }),
      })
    }
    catch
    {
      // ignore best-effort eviction failures
    }
    finally
    {
      if (this.lastModel === model)
      {
        this.lastModel = null
      }
    }
  }

  // fetch model details such as context window and KV dimensions
  async showModel(model: string, signal?: AbortSignal): Promise<ModelInfo>
  {
    const data = await this.jsonRequest<{
      model_info?: Record<string, unknown>
      parameters?: string
    }>('/api/show', { body: { model }, signal })

    const info = data.model_info ?? {}
    const arch =
      typeof info['general.architecture'] === 'string'
        ? (info['general.architecture'] as string)
        : undefined

    // prefer the architecture-specific value so training-time caps are ignored
    let contextLength = (arch && numAt(info, `${arch}.context_length`)) || 0
    if (contextLength === 0)
    {
      contextLength = scanContextLength(info)
    }

    // fall back to the parameters string when metadata omits the value
    if (contextLength === 0 && data.parameters)
    {
      const match = data.parameters.match(/num_ctx\s+(\d+)/)
      if (match)
      {
        contextLength = parseInt(match[1]!, 10)
      }
    }

    return {
      contextLength,
      architecture: arch,
      blockCount: arch ? numAt(info, `${arch}.block_count`) : undefined,
      kvHeadCount: arch
        ? numAt(info, `${arch}.attention.head_count_kv`)
        : undefined,
      keyLength: arch ? numAt(info, `${arch}.attention.key_length`) : undefined,
      valueLength: arch
        ? numAt(info, `${arch}.attention.value_length`)
        : undefined,
    }
  }

  // fetch available models from the Ollama instance
  async listModels(signal?: AbortSignal): Promise<Model[]>
  {
    const data = await this.jsonRequest<{ models: Model[] }>('/api/tags', {
      signal,
    })
    if (!data || !Array.isArray(data.models))
    {
      throw new OllamaModelIdentityError(
        'invalid_response',
        'Ollama /api/tags response did not include a models array'
      )
    }
    return data.models
  }

  // resolve a display label to Ollama's immutable local manifest digest
  async resolveModelArtifact(
    model: string,
    signal?: AbortSignal
  ): Promise<OllamaModelArtifact>
  {
    const requestedKey = modelLookupKey(model)
    const matches = (await this.listModels(signal)).filter((candidate) =>
    {
      if (!candidate || typeof candidate !== 'object') return false
      const names = [candidate.name, candidate.model].filter(
        (name): name is string => typeof name === 'string' && name.length > 0
      )
      return names.some((name) => modelLookupKey(name) === requestedKey)
    })

    if (matches.length === 0)
    {
      throw new OllamaModelIdentityError(
        'missing',
        `Embedding model "${model}" is not listed by Ollama at ${this.baseUrl}; pull it or configure an installed embedding model`
      )
    }

    if (matches.length > 1)
    {
      throw new OllamaModelIdentityError(
        'ambiguous',
        `Embedding model "${model}" matches multiple Ollama /api/tags entries; configure one exact listed model name`
      )
    }

    const match = matches[0]!
    const digest = normalizedArtifactDigest(match.digest)
    if (!digest)
    {
      throw new OllamaModelIdentityError(
        'invalid_digest',
        `Embedding model "${model}" has no valid immutable SHA-256 digest in Ollama /api/tags; upgrade Ollama before using persistent semantic retrieval`
      )
    }

    const canonicalModel =
      (typeof match.model === 'string' && match.model.trim()) ||
      (typeof match.name === 'string' && match.name.trim())
    if (!canonicalModel)
    {
      throw new OllamaModelIdentityError(
        'invalid_response',
        `Embedding model "${model}" has no valid name in Ollama /api/tags`
      )
    }

    return {
      model: canonicalModel,
      digest,
    }
  }

  // generate embeddings through Ollama's /api/embed endpoint
  async embed(
    model: string,
    input: string[],
    signal?: AbortSignal
  ): Promise<number[][]>
  {
    if (input.length === 0) return []

    const data = await this.jsonRequest<EmbedResponse>('/api/embed', {
      body: {
        model,
        input,
        keep_alive: DEFAULT_KEEP_ALIVE,
      },
      signal,
    })

    if (!Array.isArray(data.embeddings))
    {
      throw new Error('Ollama embed response did not include embeddings')
    }

    if (data.embeddings.length !== input.length)
    {
      throw new Error(
        `Ollama embed response count mismatch: expected ${input.length}, got ${data.embeddings.length}`
      )
    }

    for (const embedding of data.embeddings)
    {
      if (
        !Array.isArray(embedding) ||
        embedding.length === 0 ||
        embedding.some(
          (value) => typeof value !== 'number' || !Number.isFinite(value)
        )
      )
      {
        throw new Error('Ollama embed response included an invalid embedding')
      }
    }

    return data.embeddings
  }

  // stream chat completions via NDJSON
  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatResponse>
  {
    const res = await this.postChat(request, signal)
    if (!res.body) throw new Error('No response body')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    // collect partial-line chunks to avoid repeated string concatenation
    const remainderParts: string[] = []

    try
    {
      while (true)
      {
        if (signal?.aborted)
        {
          break
        }

        const { done, value } = await reader.read()
        if (done) break

        remainderParts.push(decoder.decode(value, { stream: true }))
        const joined = remainderParts.join('')
        remainderParts.length = 0

        const lines = joined.split('\n')
        const tail = lines.pop() ?? ''
        if (tail) remainderParts.push(tail)

        for (const line of lines)
        {
          if (line.trim())
          {
            yield JSON.parse(line) as ChatResponse
          }
        }
      }

      if (!signal?.aborted)
      {
        const final = remainderParts.join('')
        if (final.trim())
        {
          yield JSON.parse(final) as ChatResponse
        }
      }
    }
    finally
    {
      await reader.cancel()
    }
  }
}
