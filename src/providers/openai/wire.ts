// src/providers/openai/wire.ts
// map Coral chat requests and responses onto the OpenAI Responses API

import type {
  FunctionTool,
  Response,
  ResponseInputItem,
  ResponseCreateParamsStreaming,
  ResponseReasoningItem,
} from 'openai/resources/responses/responses'
import type { ReasoningEffort } from 'openai/resources/shared'
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelRequestMessage,
  OllamaToolCall,
  ProviderState,
} from '../../types/inference.js'
import type { HostedEffort } from '../config.js'
import type { BillingUsage } from '../../types/session-cost.js'
import { isPlainObject } from '../../utils/guards.js'

export const OPENAI_PROVIDER = 'openai'

const DEFAULT_MAX_OUTPUT_TOKENS = 16_000
// reasoning tokens count against max_output_tokens, so tiny utility calls such
// as session titles run at minimal effort with room left for the answer
const SHORT_REQUEST_TOKENS = 1_024
const MIN_MAX_OUTPUT_TOKENS = 2_048
const INTERRUPTED_TOOL_RESULT = 'Error: Tool call interrupted'

interface OpenAIModelLimits
{
  contextLength: number
  maxOutputTokens: number
}

// the Models API reports no window, so known families carry their published
// limits and anything else gets a conservative default
const MODEL_LIMITS: readonly [RegExp, OpenAIModelLimits][] = [
  [/^gpt-6/, { contextLength: 1_050_000, maxOutputTokens: 128_000 }],
  [/^gpt-5/, { contextLength: 400_000, maxOutputTokens: 128_000 }],
]
const FALLBACK_LIMITS: OpenAIModelLimits = {
  contextLength: 128_000,
  maxOutputTokens: 32_000,
}

// only these reasoning models accept effort `none`
const NO_REASONING_MODELS = /^(gpt-6\.1-terra|gpt-6-luna)/

// hide audio, image, embedding, and search variants from the chat picker
const CHAT_MODEL = /^gpt-\d/
const NON_CHAT_MODEL = /audio|realtime|transcribe|tts|image|search|embedding/

export function openAIModelLimits(model: string): OpenAIModelLimits
{
  return (
    MODEL_LIMITS.find(([pattern]) => pattern.test(model))?.[1] ??
    FALLBACK_LIMITS
  )
}

export function isOpenAIChatModel(
  id: string,
  shutdownDate?: string | null,
  now = Date.now()
): boolean
{
  if (!CHAT_MODEL.test(id) || NON_CHAT_MODEL.test(id)) return false
  if (!shutdownDate) return true
  const shutdown = Date.parse(shutdownDate)
  return Number.isNaN(shutdown) || shutdown > now
}

export function toOpenAIModel(id: string): Model
{
  return { name: id, model: id }
}

function effortFor(
  think: ChatRequest['think'],
  configured: HostedEffort,
  model: string,
  shortRequest: boolean
): ReasoningEffort
{
  if (think === false || shortRequest)
  {
    return NO_REASONING_MODELS.test(model) ? 'none' : 'low'
  }
  if (think === 'low' || think === 'medium' || think === 'high') return think
  return configured
}

export function syntheticCallId(messageIndex: number, callIndex: number)
{
  return `coral_${messageIndex}_${callIndex}`
}

// replay encrypted reasoning only into the model that produced it
function replayableReasoning(
  message: ModelRequestMessage,
  model: string
): ResponseInputItem[]
{
  const state = message.providerState
  if (!state || state.provider !== OPENAI_PROVIDER || state.model !== model)
  {
    return []
  }
  return state.items as ResponseInputItem[]
}

// flatten Coral history into Responses input items: leading system text
// becomes `instructions`, later system text becomes developer messages, and
// tool results pair with function calls by position
export function toOpenAIInput(
  messages: readonly ModelRequestMessage[],
  model: string
): { instructions: string; input: ResponseInputItem[] }
{
  const instructions: string[] = []
  const input: ResponseInputItem[] = []
  let pendingCallIds: string[] = []
  let seenConversation = false

  // every function call needs an output before the next model turn
  const closePendingCalls = () =>
  {
    for (const callId of pendingCallIds)
    {
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: INTERRUPTED_TOOL_RESULT,
      })
    }
    pendingCallIds = []
  }

  messages.forEach((message, index) =>
  {
    if (message.role === 'system')
    {
      if (!seenConversation) instructions.push(message.content)
      else if (message.content.trim())
      {
        input.push({ role: 'developer', content: message.content })
      }
      return
    }
    seenConversation = true

    if (message.role === 'tool')
    {
      const callId = pendingCallIds.shift()
      const output = message.content || '(no output)'
      if (callId === undefined)
      {
        input.push({
          role: 'user',
          content: `Tool result (${message.tool_name ?? 'unknown'}):\n${output}`,
        })
        return
      }
      input.push({ type: 'function_call_output', call_id: callId, output })
      return
    }

    closePendingCalls()
    if (message.role === 'user')
    {
      if (message.content.trim())
      {
        input.push({ role: 'user', content: message.content })
      }
      return
    }

    input.push(...replayableReasoning(message, model))
    if (message.content.trim())
    {
      input.push({ role: 'assistant', content: message.content })
    }
    message.tool_calls?.forEach((call, callIndex) =>
    {
      const callId = call.id ?? syntheticCallId(index, callIndex)
      input.push({
        type: 'function_call',
        call_id: callId,
        name: call.function.name,
        arguments: JSON.stringify(call.function.arguments),
      })
      pendingCallIds.push(callId)
    })
  })
  closePendingCalls()

  return { instructions: instructions.join('\n\n'), input }
}

function toOpenAITools(tools: ChatRequest['tools']): FunctionTool[]
{
  return (tools ?? []).map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }))
}

export function toOpenAIRequest(
  request: ChatRequest,
  effort: HostedEffort
): Omit<ResponseCreateParamsStreaming, 'stream'>
{
  const { instructions, input } = toOpenAIInput(request.messages, request.model)
  const tools = toOpenAITools(request.tools)
  const requested =
    request.num_predict && request.num_predict > 0
      ? request.num_predict
      : DEFAULT_MAX_OUTPUT_TOKENS
  const shortRequest = requested < SHORT_REQUEST_TOKENS
  return {
    model: request.model,
    ...(instructions ? { instructions } : {}),
    input,
    ...(tools.length > 0 ? { tools } : {}),
    max_output_tokens: Math.max(requested, MIN_MAX_OUTPUT_TOKENS),
    reasoning: {
      effort: effortFor(request.think, effort, request.model, shortRequest),
      summary: 'auto',
    },
    // stateless: OpenAI keeps nothing, so reasoning returns encrypted for replay
    store: false,
    include: ['reasoning.encrypted_content'],
  }
}

function parseArguments(raw: string): Record<string, unknown>
{
  try
  {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }
  catch
  {
    return {}
  }
}

function toolCallsFrom(response: Response): OllamaToolCall[]
{
  return response.output.flatMap((item) =>
    item.type === 'function_call'
      ? [
          {
            id: item.call_id,
            type: 'function' as const,
            function: {
              name: item.name,
              arguments: parseArguments(item.arguments),
            },
          },
        ]
      : []
  )
}

function refusalFrom(response: Response): string | undefined
{
  for (const item of response.output)
  {
    if (item.type !== 'message') continue
    for (const part of item.content)
    {
      if (part.type === 'refusal') return part.refusal
    }
  }
  return undefined
}

// keep encrypted reasoning items; text and calls rebuild from Coral history
function providerStateFrom(
  response: Response,
  model: string
): ProviderState | undefined
{
  const reasoning = response.output.filter(
    (item): item is ResponseReasoningItem =>
      item.type === 'reasoning' && Boolean(item.encrypted_content)
  )
  if (reasoning.length === 0) return undefined
  return {
    provider: OPENAI_PROVIDER,
    model,
    items: structuredClone(reasoning),
  }
}

// input totals include reads and writes; reasoning is already part of output
export function billingUsageFrom(response: Response): BillingUsage | undefined
{
  const usage = response.usage
  if (!usage) return undefined
  const details = usage.input_tokens_details
  const reads = details?.cached_tokens ?? 0
  const writes = details?.cache_write_tokens ?? 0
  const rawDetails: unknown = details
  const split = isPlainObject(rawDetails)
    ? rawDetails.cache_write_tokens_details
    : undefined
  const long =
    isPlainObject(split) && typeof split.ttl_12h_tokens === 'number'
      ? split.ttl_12h_tokens
      : 0
  return {
    model: `openai/${response.model}`,
    serviceTier: response.service_tier ?? 'default',
    inputTokens: usage.input_tokens - reads - writes,
    cacheReadTokens: reads,
    // use the default 30m lifetime when no split is returned
    cacheWriteShortTokens: writes - long,
    cacheWriteLongTokens: long,
    outputTokens: usage.output_tokens,
  }
}

// translate a finished response into Coral's single terminal stream chunk
export function finalChunkFrom(
  response: Response,
  model: string
): ChatResponse
{
  const refusal = refusalFrom(response)
  if (refusal) throw new Error(`OpenAI model refused this request: ${refusal}`)

  const toolCalls = toolCallsFrom(response)
  if (
    response.status === 'incomplete' &&
    response.incomplete_details?.reason === 'max_output_tokens' &&
    toolCalls.length > 0
  )
  {
    throw new Error(
      'OpenAI model hit the output token limit mid tool call; the call was not run'
    )
  }

  const usage = response.usage
  const providerState = providerStateFrom(response, model)
  return {
    message: {
      role: 'assistant',
      content: '',
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(providerState ? { providerState } : {}),
    },
    done: true,
    prompt_eval_count: usage?.input_tokens ?? 0,
    eval_count: usage?.output_tokens ?? 0,
    cached_prompt_count: usage?.input_tokens_details?.cached_tokens ?? 0,
  }
}
