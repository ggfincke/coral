// src/providers/anthropic/wire.ts
// map Coral chat requests and responses onto the Anthropic Messages API

import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTool,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type {
  ChatRequest,
  ChatResponse,
  ModelRequestMessage,
  OllamaToolCall,
  ProviderState,
} from '../../types/inference.js'
import type { HostedEffort } from '../config.js'
import type { BillingUsage } from '../../types/session-cost.js'

export const ANTHROPIC_PROVIDER = 'anthropic'

// refusal fallback routes by category on the server; thinking binding lets
// history edits drop stale reasoning instead of failing the request
export const ANTHROPIC_BETAS = [
  'server-side-fallback-2026-07-01',
  'thinking-binding-controls-2026-08-01',
]

const DEFAULT_MAX_TOKENS = 16_000
// thinking cannot be turned off, so tiny utility calls such as session titles
// run at low effort with enough room to reason before the visible answer
const SHORT_REQUEST_TOKENS = 1_024
const MIN_MAX_TOKENS = 2_048
const INTERRUPTED_TOOL_RESULT = 'Error: Tool call interrupted'

type UserBlock = BetaContentBlockParam

function effortFor(
  think: ChatRequest['think'],
  configured: HostedEffort,
  shortRequest: boolean
): HostedEffort
{
  // thinking cannot be disabled on current Claude models, so off means low
  if (think === false || shortRequest) return 'low'
  if (think === 'low' || think === 'medium' || think === 'high') return think
  return configured
}

export function syntheticToolUseId(messageIndex: number, callIndex: number)
{
  return `coral_${messageIndex}_${callIndex}`
}

// replay signed blocks only into the conversation and model that made them
function replayableItems(
  message: ModelRequestMessage,
  model: string
): BetaContentBlockParam[] | undefined
{
  const state = message.providerState
  if (
    !state ||
    state.provider !== ANTHROPIC_PROVIDER ||
    state.model !== model ||
    state.items.length === 0
  )
  {
    return undefined
  }
  const items = state.items as BetaContentBlockParam[]
  // a turn of reasoning alone is not a valid assistant message to replay
  const visible = items.some(
    (item) => item.type === 'text' || item.type === 'tool_use'
  )
  return visible ? items : undefined
}

function rebuiltAssistantBlocks(
  message: ModelRequestMessage,
  messageIndex: number
): BetaContentBlockParam[]
{
  const blocks: BetaContentBlockParam[] = []
  if (message.content.trim())
  {
    blocks.push({ type: 'text', text: message.content })
  }
  message.tool_calls?.forEach((call, callIndex) =>
  {
    blocks.push({
      type: 'tool_use',
      id: call.id ?? syntheticToolUseId(messageIndex, callIndex),
      name: call.function.name,
      input: call.function.arguments,
    })
  })
  return blocks
}

function toolUseIds(blocks: readonly BetaContentBlockParam[]): string[]
{
  return blocks.flatMap((block) =>
    block.type === 'tool_use' ? [block.id] : []
  )
}

// convert Coral's flat role history into alternating Anthropic turns: leading
// system text lifts into `system`, later system text and tool results join the
// adjacent user turn, and tool results pair with calls by position
export function toAnthropicMessages(
  messages: readonly ModelRequestMessage[],
  model: string
): { system: string; messages: BetaMessageParam[] }
{
  const systemParts: string[] = []
  const turns: BetaMessageParam[] = []
  let pendingToolIds: string[] = []

  const userBlocks = (): UserBlock[] =>
  {
    const last = turns.at(-1)
    if (last?.role === 'user' && Array.isArray(last.content))
    {
      return last.content
    }
    const content: UserBlock[] = []
    turns.push({ role: 'user', content })
    return content
  }

  // every tool_use needs a result before the next assistant turn
  const closePendingTools = () =>
  {
    if (pendingToolIds.length === 0) return
    const blocks = userBlocks()
    for (const id of pendingToolIds)
    {
      blocks.push({
        type: 'tool_result',
        tool_use_id: id,
        content: INTERRUPTED_TOOL_RESULT,
        is_error: true,
      })
    }
    pendingToolIds = []
  }

  messages.forEach((message, index) =>
  {
    if (message.role === 'system')
    {
      if (turns.length === 0) systemParts.push(message.content)
      else if (message.content.trim())
      {
        userBlocks().push({ type: 'text', text: message.content })
      }
      return
    }

    if (message.role === 'tool')
    {
      const id = pendingToolIds.shift()
      const content = message.content || '(no output)'
      if (id === undefined)
      {
        userBlocks().push({
          type: 'text',
          text: `Tool result (${message.tool_name ?? 'unknown'}):\n${content}`,
        })
        return
      }
      const result: BetaToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: id,
        content,
      }
      if (content.startsWith('Error:')) result.is_error = true
      userBlocks().push(result)
      return
    }

    if (message.role === 'user')
    {
      closePendingTools()
      if (message.content.trim())
      {
        userBlocks().push({ type: 'text', text: message.content })
      }
      return
    }

    closePendingTools()
    const blocks =
      replayableItems(message, model) ?? rebuiltAssistantBlocks(message, index)
    if (blocks.length === 0) return
    turns.push({ role: 'assistant', content: blocks })
    pendingToolIds = toolUseIds(blocks)
  })
  closePendingTools()

  // the API requires a leading user turn
  if (turns[0]?.role !== 'user')
  {
    turns.unshift({
      role: 'user',
      content: [{ type: 'text', text: '(conversation resumed)' }],
    })
  }

  return { system: systemParts.join('\n\n'), messages: turns }
}

function toAnthropicTools(tools: ChatRequest['tools']): BetaTool[]
{
  return (tools ?? []).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters as BetaTool['input_schema'],
  }))
}

export function toAnthropicRequest(
  request: ChatRequest,
  effort: HostedEffort
): BetaMessageStreamParams
{
  const { system, messages } = toAnthropicMessages(
    request.messages,
    request.model
  )
  const tools = toAnthropicTools(request.tools)
  const requested =
    request.num_predict && request.num_predict > 0
      ? request.num_predict
      : DEFAULT_MAX_TOKENS
  const shortRequest = requested < SHORT_REQUEST_TOKENS
  return {
    model: request.model,
    max_tokens: Math.max(requested, MIN_MAX_TOKENS),
    ...(system ? { system } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    // summarized display keeps the model's reasoning visible in the TUI
    thinking: {
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    },
    output_config: { effort: effortFor(request.think, effort, shortRequest) },
    cache_control: { type: 'ephemeral' },
    fallbacks: 'default',
    betas: ANTHROPIC_BETAS,
  }
}

function toolCallsFrom(content: readonly BetaContentBlock[]): OllamaToolCall[]
{
  return content.flatMap((block) =>
    block.type === 'tool_use'
      ? [
          {
            id: block.id,
            type: 'function' as const,
            function: {
              name: block.name,
              arguments:
                block.input && typeof block.input === 'object'
                  ? (block.input as Record<string, unknown>)
                  : {},
            },
          },
        ]
      : []
  )
}

// keep the exact response blocks only when they carry signed reasoning that
// a rebuilt turn could not reproduce
function providerStateFrom(
  message: BetaMessage,
  model: string
): ProviderState | undefined
{
  const signed = message.content.some(
    (block) => block.type === 'thinking' || block.type === 'redacted_thinking'
  )
  if (!signed) return undefined
  return {
    provider: ANTHROPIC_PROVIDER,
    model,
    items: structuredClone(message.content),
  }
}

export function billingUsageFrom(message: BetaMessage): BillingUsage
{
  const usage = message.usage
  const long = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
  return {
    model: `anthropic/${message.model}`,
    serviceTier:
      usage.speed === 'fast' ? 'fast' : (usage.service_tier ?? 'standard'),
    inputTokens: usage.input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteShortTokens: (usage.cache_creation_input_tokens ?? 0) - long,
    cacheWriteLongTokens: long,
    outputTokens: usage.output_tokens,
  }
}

// translate a finished message into Coral's single terminal stream chunk
export function finalChunkFrom(
  message: BetaMessage,
  model: string
): ChatResponse
{
  const toolCalls = toolCallsFrom(message.content)
  if (message.stop_reason === 'refusal')
  {
    const category = message.stop_details?.category
    throw new Error(
      `Claude declined this request${category ? ` (${category})` : ''}`
    )
  }
  if (message.stop_reason === 'max_tokens' && toolCalls.length > 0)
  {
    throw new Error(
      'Claude hit the output token limit mid tool call; the call was not run'
    )
  }

  const usage = message.usage
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const dropped = (message.input_transformations ?? []).filter(
    (entry) => entry.type === 'thinking_dropped'
  ).length
  const providerState = providerStateFrom(message, model)

  return {
    message: {
      role: 'assistant',
      content: '',
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(providerState ? { providerState } : {}),
    },
    done: true,
    prompt_eval_count: usage.input_tokens + cacheRead + cacheWrite,
    eval_count: usage.output_tokens,
    cached_prompt_count: cacheRead,
    dropped_thinking_count: dropped,
  }
}
