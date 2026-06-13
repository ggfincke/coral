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
export type {
  ChatRequest,
  ChatResponse,
  EmbedResponse,
  JsonSchema,
  Model,
  ModelInfo,
  OllamaMessage,
  OllamaTool,
  OllamaToolCall,
} from '../types/inference.js'

const DEFAULT_KEEP_ALIVE = '10m'
const THINK_FALLBACK_STATUS = new Set([400, 404, 422])
type ThinkSupport = 'unknown' | 'supported' | 'unsupported'

function throwApiError(status: number, body: string): never
{
  throw new Error(
    body ? `Ollama API error: ${status} ${body}` : `Ollama API error: ${status}`
  )
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
    const { num_ctx, ...rest } = request
    const body: Record<string, unknown> = {
      ...rest,
      keep_alive: request.keep_alive ?? DEFAULT_KEEP_ALIVE,
      stream: true,
    }

    if (!includeThink)
    {
      delete body.think
    }

    if (typeof num_ctx === 'number' && num_ctx > 0)
    {
      body.options = { num_ctx }
    }

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

  // POST a chat body, mapping connection failures to an actionable message —
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    }
    catch (err)
    {
      if (signal?.aborted) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Cannot reach Ollama at ${this.baseUrl} — the server may be down, or ` +
          `the request may have exceeded the model's context or memory (${detail})`
      )
    }
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
        headers: { 'Content-Type': 'application/json' },
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

  // fetch model details (context window, etc.) from the Ollama instance
  async showModel(model: string): Promise<ModelInfo>
  {
    const res = await fetch(`${this.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    })
    if (!res.ok) throw new Error(`Ollama API error: ${res.status}`)

    const data = (await res.json()) as {
      model_info?: Record<string, unknown>
      parameters?: string
    }

    // extract context length from model_info or parameters
    let contextLength = 0

    // try model_info first — Ollama returns context_length in various keys
    if (data.model_info)
    {
      for (const [key, val] of Object.entries(data.model_info))
      {
        if (key.includes('context_length') && typeof val === 'number')
        {
          contextLength = val
          break
        }
      }
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

    return { context_length: contextLength }
  }

  // fetch available models from the Ollama instance
  async listModels(): Promise<Model[]>
  {
    const res = await fetch(`${this.baseUrl}/api/tags`)
    if (!res.ok) throw new Error(`Ollama API error: ${res.status}`)
    const data = (await res.json()) as { models: Model[] }
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

    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input,
        keep_alive: DEFAULT_KEEP_ALIVE,
      }),
      signal,
    })

    if (!res.ok) throwApiError(res.status, await res.text())

    const data = (await res.json()) as EmbedResponse
    if (!Array.isArray(data.embeddings))
    {
      throw new Error('Ollama embed response did not include embeddings')
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
