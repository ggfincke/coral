// src/ollama/client.ts
// Ollama REST API client w/ streaming chat

// JSON Schema subset for tool parameters
export interface JsonSchema
{
  type: 'object'
  properties: Record<
    string,
    {
      type: string
      description?: string
      enum?: string[]
    }
  >
  required?: string[]
}

// chat message
export interface OllamaMessage
{
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  tool_name?: string
  tool_calls?: OllamaToolCall[]
}

// tool call returned by the model
export interface OllamaToolCall
{
  type?: 'function'
  function: {
    index?: number
    name: string
    arguments: Record<string, unknown>
  }
}

// tool definition sent to the model
export interface OllamaTool
{
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JsonSchema
  }
}

// request payload for /api/chat
export interface ChatRequest
{
  model: string
  messages: OllamaMessage[]
  stream?: boolean
  tools?: OllamaTool[]
  think?: boolean | 'low' | 'medium' | 'high'
  keep_alive?: string | number
}

// response chunk from /api/chat
export interface ChatResponse
{
  message: OllamaMessage
  done: boolean
  done_reason?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

// model metadata from /api/tags
export interface Model
{
  name: string
  size: number
  modified_at: string
}

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

  constructor(private baseUrl = 'http://localhost:11434')
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
    const body: Record<string, unknown> = {
      ...request,
      keep_alive: request.keep_alive ?? DEFAULT_KEEP_ALIVE,
      stream: true,
    }

    if (!includeThink)
    {
      delete body.think
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

  // open a chat stream & fall back when think is unsupported
  private async postChat(request: ChatRequest): Promise<Response>
  {
    const thinkSupport = this.getThinkSupport(request.model)
    const includeThink =
      request.think !== undefined &&
      request.think !== false &&
      thinkSupport !== 'unsupported'
    const initial = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildChatBody(request, includeThink)),
    })

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

    const retry = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildChatBody(request, false)),
    })

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

  // keep API compatibility w/ existing call sites
  stopKeepAlive(): void
  {
    // no-op
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

  // fetch available models from the Ollama instance
  async listModels(): Promise<Model[]>
  {
    const res = await fetch(`${this.baseUrl}/api/tags`)
    if (!res.ok) throw new Error(`Ollama API error: ${res.status}`)
    const data = (await res.json()) as { models: Model[] }
    return data.models
  }

  // stream chat completions via ndjson
  async *chatStream(request: ChatRequest): AsyncGenerator<ChatResponse>
  {
    const res = await this.postChat(request)
    if (!res.body) throw new Error('No response body')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    // collect partial-line chunks in an array to avoid O(n²) string concat
    const remainderParts: string[] = []

    while (true)
    {
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

    const final = remainderParts.join('')
    if (final.trim())
    {
      yield JSON.parse(final) as ChatResponse
    }
  }
}
