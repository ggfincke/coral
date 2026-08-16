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

const MAX_ERROR_BYTES = 64 * 1024

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

  evictModel(model: string): Promise<void>
  {
    return this.inner.evictModel(model)
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
