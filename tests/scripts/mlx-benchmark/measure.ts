// tests/scripts/mlx-benchmark/measure.ts
// request-level timing and clean tool-call evidence around an inference client

import type { AgentInferenceClient } from '../../../src/agent/inference-client.js'
import type {
  ChatRequest,
  ChatResponse,
  OllamaToolCall,
} from '../../../src/types/inference.js'

export interface RequestMeasurement
{
  firstDeltaMs: number
  wallMs: number
  promptTokens: number
  completionTokens: number
  providerPromptDurationNs: number
  providerEvalDurationNs: number
  thinkingChars: number
  contentChars: number
  reasoningWithToolCall: boolean
  textBeforeToolCall: boolean
  toolCalls: OllamaToolCall[]
}

function mergeCalls(
  calls: Map<string, OllamaToolCall>,
  incoming: OllamaToolCall[]
): void
{
  for (const [position, call] of incoming.entries())
  {
    const key = `${call.function.index ?? position}:${call.function.name}`
    calls.set(key, call)
  }
}

export class MeasuredInferenceClient implements AgentInferenceClient
{
  private readonly observations: RequestMeasurement[] = []

  constructor(
    private readonly inner: AgentInferenceClient,
    private readonly maxOutputTokens: number
  )
  {}

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

  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatResponse>
  {
    const started = performance.now()
    let firstDeltaMs = 0
    let firstDeltaSeen = false
    let promptTokens = 0
    let completionTokens = 0
    let providerPromptDurationNs = 0
    let providerEvalDurationNs = 0
    let thinkingChars = 0
    let contentChars = 0
    let textBeforeToolCall = false
    let sawToolCall = false
    const calls = new Map<string, OllamaToolCall>()

    try
    {
      for await (const chunk of this.inner.chatStream(
        { ...request, num_predict: this.maxOutputTokens },
        signal
      ))
      {
        const hasDelta = Boolean(
          chunk.message.content ||
          chunk.message.thinking ||
          chunk.message.tool_calls?.length
        )
        if (hasDelta && !firstDeltaSeen)
        {
          firstDeltaSeen = true
          firstDeltaMs = performance.now() - started
        }
        if (chunk.message.content)
        {
          if (!sawToolCall) textBeforeToolCall = true
          contentChars += chunk.message.content.length
        }
        if (chunk.message.thinking)
        {
          thinkingChars += chunk.message.thinking.length
        }
        if (chunk.message.tool_calls?.length)
        {
          sawToolCall = true
          mergeCalls(calls, chunk.message.tool_calls)
        }
        if (chunk.done)
        {
          promptTokens = chunk.prompt_eval_count ?? promptTokens
          completionTokens = chunk.eval_count ?? completionTokens
          providerPromptDurationNs =
            chunk.prompt_eval_duration ?? providerPromptDurationNs
          providerEvalDurationNs = chunk.eval_duration ?? providerEvalDurationNs
        }
        yield chunk
      }
    }
    finally
    {
      this.observations.push({
        firstDeltaMs,
        wallMs: performance.now() - started,
        promptTokens,
        completionTokens,
        providerPromptDurationNs,
        providerEvalDurationNs,
        thinkingChars,
        contentChars,
        reasoningWithToolCall: thinkingChars > 0 && calls.size > 0,
        textBeforeToolCall: sawToolCall && textBeforeToolCall,
        toolCalls: [...calls.values()],
      })
    }
  }

  takeMeasurements(): RequestMeasurement[]
  {
    return this.observations.splice(0)
  }
}

export function requestMetrics(
  measurements: RequestMeasurement[],
  measurementIndex?: number
): {
  firstDeltaMs: number
  promptTokensPerSecond: number
  decodeTokensPerSecond: number
}
{
  if (measurements.length === 0)
  {
    return {
      firstDeltaMs: 0,
      promptTokensPerSecond: 0,
      decodeTokensPerSecond: 0,
    }
  }
  const selected =
    measurementIndex === undefined
      ? measurements
      : measurements[measurementIndex]
        ? [measurements[measurementIndex]]
        : []
  if (selected.length === 0)
  {
    throw new Error(`missing request measurement ${measurementIndex}`)
  }
  const promptTokens = selected.reduce(
    (sum, item) => sum + item.promptTokens,
    0
  )
  const completionTokens = selected.reduce(
    (sum, item) => sum + item.completionTokens,
    0
  )
  const promptWallMs = selected.reduce(
    (sum, item) => sum + item.firstDeltaMs,
    0
  )
  const decodeWallMs = selected.reduce(
    (sum, item) => sum + Math.max(item.wallMs - item.firstDeltaMs, 0),
    0
  )
  return {
    firstDeltaMs: selected[0]!.firstDeltaMs,
    promptTokensPerSecond:
      promptWallMs > 0 ? promptTokens / (promptWallMs / 1_000) : 0,
    decodeTokensPerSecond:
      decodeWallMs > 0 ? completionTokens / (decodeWallMs / 1_000) : 0,
  }
}
