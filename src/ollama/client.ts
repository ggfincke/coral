// src/ollama/client.ts
// Ollama REST API client w/ streaming chat

import type {
  ChatRequest,
  ChatResponse,
  EmbedResponse,
  Model,
  ModelInfo,
} from '../types/inference.js'
import { DEFAULT_OLLAMA_HOST } from './host.js'
import { toErrorMessage } from '../utils/errors.js'

const DEFAULT_KEEP_ALIVE = '10m'
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const
const THINK_FALLBACK_STATUS = new Set([400, 404, 422])
type ThinkSupport = 'unknown' | 'supported' | 'unsupported'

interface JsonRequestOptions
{
  method?: string
  body?: unknown
  signal?: AbortSignal
}

function throwApiError(status: number, body: string): never
{
  throw new Error(
    body ? `Ollama API error: ${status} ${body}` : `Ollama API error: ${status}`
  )
}

function formatConnectionError(baseUrl: string, detail: string): string
{
  return `Cannot reach Ollama at ${baseUrl}: ${detail}`
}

// read an exact numeric key from an Ollama model_info map
function numAt(info: Record<string, unknown>, key: string): number | undefined
{
  const val = info[key]
  return typeof val === 'number' ? val : undefined
}

// fall back to any *.context_length key, skipping training-time/original caps
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
  private lastModel: string | null = null
  private thinkSupportByModel = new Map<string, ThinkSupport>()

  constructor(private baseUrl = DEFAULT_OLLAMA_HOST)
  {}

  // decide whether the server rejected the think field specifically
  private shouldRetryWithoutThink(status: number, errorText: string): boolean
  {
    if (!THINK_FALLBACK_STATUS.has(status)) return false

    const normalized = errorText.toLowerCase()
    // only retry when the error clearly references the think field
    return normalized.includes('think') || normalized.includes('unknown field')
  }

  // build a /api/chat payload while optionally omitting think
  private buildChatBody(
    request: ChatRequest,
    includeThink: boolean
  ): Record<string, unknown>
  {
    // ! never add a `format` field to tool-bearing requests — it silently
    // ! empties tool_calls (ollama#8095)
    // num_ctx is a top-level convenience field — Ollama expects it under options
    const { num_ctx, num_predict, ...rest } = request
    const body: Record<string, unknown> = {
      ...rest,
      keep_alive: request.keep_alive ?? DEFAULT_KEEP_ALIVE,
      stream: true,
    }

    if (!includeThink)
    {
      delete body.think
    }

    const options: Record<string, number> = {}
    if (typeof num_ctx === 'number' && num_ctx > 0) options.num_ctx = num_ctx
    if (typeof num_predict === 'number' && num_predict > 0)
    {
      options.num_predict = num_predict
    }
    if (Object.keys(options).length > 0) body.options = options

    return body
  }

  // read cached think capability for a specific model
  private getThinkSupport(model: string): ThinkSupport
  {
    return this.thinkSupportByModel.get(model) ?? 'unknown'
  }

  // record think capability for a specific model
  private setThinkSupport(model: string, support: ThinkSupport): void
  {
    this.thinkSupportByModel.set(model, support)
  }

  // POST a chat body, mapping connection failures to an actionable message
  // undici surfaces a dropped socket (server down, OOM, oversized request) as a
  // bare "fetch failed", so translate it while letting aborts propagate as-is
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

  // fetch a non-streaming JSON endpoint w/ shared error handling
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

  // open a chat stream & fall back when think is unsupported
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

  // track the active model so Coral can unload it on shutdown
  startKeepAlive(model: string): void
  {
    this.lastModel = model
  }

  // unload a tracked model immediately
  async unloadModel(model = this.lastModel): Promise<void>
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
      // swallow — shutdown unload is best-effort
    }
    finally
    {
      if (this.lastModel === model)
      {
        this.lastModel = null
      }
    }
  }

  // fetch model details (context window, KV dims, etc.) from the Ollama instance
  async showModel(model: string): Promise<ModelInfo>
  {
    const data = await this.jsonRequest<{
      model_info?: Record<string, unknown>
      parameters?: string
    }>('/api/show', { body: { model } })

    const info = data.model_info ?? {}
    const arch =
      typeof info['general.architecture'] === 'string'
        ? (info['general.architecture'] as string)
        : undefined

    // prefer the exact arch-keyed value so we don't pick up training-time caps
    // like mistral3.rope.scaling.original_context_length
    let contextLength = (arch && numAt(info, `${arch}.context_length`)) || 0
    if (contextLength === 0)
    {
      contextLength = scanContextLength(info)
    }

    // fallback: parse from parameters string (e.g., "num_ctx 8192")
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
  async listModels(): Promise<Model[]>
  {
    const data = await this.jsonRequest<{ models: Model[] }>('/api/tags')
    return data.models
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
        embedding.some((value) => typeof value !== 'number')
      )
      {
        throw new Error('Ollama embed response included an invalid embedding')
      }
    }

    return data.embeddings
  }

  // stream chat completions via ndjson
  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatResponse>
  {
    const res = await this.postChat(request, signal)
    if (!res.body) throw new Error('No response body')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    // collect partial-line chunks in an array to avoid O(n²) string concat
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
