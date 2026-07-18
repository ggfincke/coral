// src/agent/request-budget.ts
// pure model-request capacity, estimation, & overflow policy

import type {
  ModelRequestMessage,
  OllamaMessage,
  OllamaTool,
  OllamaToolCall,
} from '../types/inference.js'
import {
  CHARS_PER_TOKEN,
  MAX_TOOL_OUTPUT_CHARS,
  estimateModelRequestValue,
  estimateUtf8Tokens,
} from '../utils/limits.js'

export const MAX_RESPONSE_RESERVE_TOKENS = 16_384
export const MAX_SUMMARY_RESPONSE_RESERVE_TOKENS = 8_192
export const MAX_REQUEST_PROMPT_TOKENS = 32_768
export const RESPONSE_RESERVE_FRACTION = 0.125
export const ATTACHMENT_FLEXIBLE_SHARE = 0.5
export const MAX_ATTACHMENT_TOKENS = MAX_TOOL_OUTPUT_CHARS / CHARS_PER_TOKEN

// messages are estimated as individual allowlisted objects & tool definitions
// include their own array; this frame accounts for the two properties, the
// messages array, & separators between message objects
const MODEL_REQUEST_FRAME = '{"messages":[],"tools":}'
const MODEL_REQUEST_FRAME_UTF8_BYTES =
  estimateUtf8Tokens(MODEL_REQUEST_FRAME).utf8Bytes

export interface RequestBudgetCapacity
{
  contextWindow: number
  responseReserve: number
  promptLimit: number
  summaryResponseReserve: number
  summaryPromptLimit: number
}

export interface RequestBudgetCategories
{
  systemBase: number
  projectContext: number
  storedHistory: number
  activeTurnBase: number
  activeAttachments: number
  toolDefinitions: number
  gitContext: number
  framing: number
}

export type RequestBudgetCategory = keyof RequestBudgetCategories

export interface RequestBudgetBreakdown extends RequestBudgetCapacity
{
  categories: Readonly<RequestBudgetCategories>
  fixedPromptTokens: number
  promptTokens: number
  totalTokens: number
  remainingPromptTokens: number
  remainingContextTokens: number
  overflowTokens: number
  fits: boolean
}

export type RequestBudgetOverflowCode =
  'fixed_cost_overflow' | 'history_overflow'

// retain the exact failed accounting so callers can surface an actionable
// error without rebuilding a potentially different request snapshot
export class RequestBudgetError extends Error
{
  readonly code: RequestBudgetOverflowCode
  readonly breakdown: RequestBudgetBreakdown

  constructor(
    code: RequestBudgetOverflowCode,
    breakdown: RequestBudgetBreakdown
  )
  {
    const detail = `${breakdown.promptTokens}/${breakdown.promptLimit} prompt tokens`
    const action =
      code === 'fixed_cost_overflow'
        ? 'the system prompt, active tools, and current turn cannot fit; shorten the turn, disable optional MCP tools, or raise the context limit'
        : 'protected conversation history cannot fit; start a new session, compact earlier, or raise the context limit'
    super(`Model request budget exceeded (${detail}): ${action}`)
    this.name = 'RequestBudgetError'
    this.code = code
    this.breakdown = breakdown
  }
}

const REQUEST_BUDGET_CATEGORIES: readonly RequestBudgetCategory[] = [
  'systemBase',
  'projectContext',
  'storedHistory',
  'activeTurnBase',
  'activeAttachments',
  'toolDefinitions',
  'gitContext',
  'framing',
]

function nonNegativeInteger(value: number, label: string): number
{
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value))
  {
    throw new RangeError(`${label} must be a non-negative integer`)
  }
  return value
}

function normalizedWindow(contextWindow: number): number
{
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0
  return Math.floor(contextWindow)
}

export function requestBudgetCapacity(
  contextWindow: number
): RequestBudgetCapacity
{
  const window = normalizedWindow(contextWindow)
  const responseReserve = Math.max(
    1,
    Math.min(
      MAX_RESPONSE_RESERVE_TOKENS,
      Math.floor(window * RESPONSE_RESERVE_FRACTION)
    )
  )
  const promptLimit = Math.max(
    0,
    Math.min(MAX_REQUEST_PROMPT_TOKENS, window - responseReserve)
  )
  const summaryResponseReserve = Math.min(
    MAX_SUMMARY_RESPONSE_RESERVE_TOKENS,
    responseReserve
  )
  const summaryPromptLimit = Math.max(
    0,
    Math.min(MAX_REQUEST_PROMPT_TOKENS, window - summaryResponseReserve)
  )

  return {
    contextWindow: window,
    responseReserve,
    promptLimit,
    summaryResponseReserve,
    summaryPromptLimit,
  }
}

// only the exact request fields below participate in model context; projecting
// here also keeps ui/persistence-only fields out of budget calculations
export function toModelRequestMessage(
  message: OllamaMessage | ModelRequestMessage
): ModelRequestMessage
{
  const projected: ModelRequestMessage = {
    role: message.role,
    content: message.content,
  }

  if (message.thinking !== undefined) projected.thinking = message.thinking
  if (message.tool_name !== undefined) projected.tool_name = message.tool_name
  if (message.tool_calls !== undefined)
  {
    projected.tool_calls = message.tool_calls.map(projectToolCall)
  }

  return projected
}

function projectToolCall(call: OllamaToolCall): OllamaToolCall
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

function projectToolDefinition(tool: OllamaTool): OllamaTool
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

export function estimateModelRequestMessageTokens(
  message: OllamaMessage | ModelRequestMessage
): number
{
  return estimateModelRequestValue(toModelRequestMessage(message)).tokens
}

export function estimateModelRequestMessagesTokens(
  messages: readonly (OllamaMessage | ModelRequestMessage)[]
): number
{
  return messages.reduce(
    (total, message) => total + estimateModelRequestMessageTokens(message),
    0
  )
}

export function estimateModelRequestMessageDeltaTokens(
  base: OllamaMessage | ModelRequestMessage,
  expanded: OllamaMessage | ModelRequestMessage
): number
{
  return Math.max(
    estimateModelRequestMessageTokens(expanded) -
      estimateModelRequestMessageTokens(base),
    0
  )
}

export function estimateModelRequestToolTokens(
  tools: readonly OllamaTool[]
): number
{
  return estimateModelRequestValue(tools.map(projectToolDefinition)).tokens
}

export function estimateRequestFramingTokens(messageCount: number): number
{
  const count = nonNegativeInteger(messageCount, 'messageCount')
  const separatorBytes = Math.max(count - 1, 0)
  return Math.ceil(
    (MODEL_REQUEST_FRAME_UTF8_BYTES + separatorBytes) / CHARS_PER_TOKEN
  )
}

export function createRequestBudgetBreakdown(
  contextWindow: number,
  input: Partial<RequestBudgetCategories>
): RequestBudgetBreakdown
{
  const capacity = requestBudgetCapacity(contextWindow)
  const categories = {} as RequestBudgetCategories

  for (const category of REQUEST_BUDGET_CATEGORIES)
  {
    categories[category] = nonNegativeInteger(input[category] ?? 0, category)
  }

  const promptTokens = REQUEST_BUDGET_CATEGORIES.reduce(
    (total, category) => total + categories[category],
    0
  )
  const fixedPromptTokens =
    categories.systemBase +
    categories.projectContext +
    categories.activeTurnBase +
    categories.toolDefinitions +
    categories.framing
  const totalTokens = promptTokens + capacity.responseReserve
  const promptOverflow = Math.max(promptTokens - capacity.promptLimit, 0)
  const contextOverflow = Math.max(totalTokens - capacity.contextWindow, 0)
  const overflowTokens = Math.max(promptOverflow, contextOverflow)

  return {
    ...capacity,
    categories: Object.freeze(categories),
    fixedPromptTokens,
    promptTokens,
    totalTokens,
    remainingPromptTokens: Math.max(capacity.promptLimit - promptTokens, 0),
    remainingContextTokens: Math.max(capacity.contextWindow - totalTokens, 0),
    overflowTokens,
    fits: overflowTokens === 0,
  }
}

export function requestBudgetOverflowCode(
  breakdown: RequestBudgetBreakdown
): RequestBudgetOverflowCode
{
  return breakdown.fixedPromptTokens > breakdown.promptLimit
    ? 'fixed_cost_overflow'
    : 'history_overflow'
}

export function assertRequestBudget(breakdown: RequestBudgetBreakdown): void
{
  if (breakdown.fits) return
  throw new RequestBudgetError(requestBudgetOverflowCode(breakdown), breakdown)
}

export function attachmentAllowanceTokens(
  flexibleRemainingTokens: number
): number
{
  const remaining = Math.max(0, Math.floor(flexibleRemainingTokens))
  return Math.min(
    MAX_ATTACHMENT_TOKENS,
    Math.floor(remaining * ATTACHMENT_FLEXIBLE_SHARE)
  )
}

export function attachmentAllowanceForFixedCost(
  promptLimit: number,
  fixedPromptTokens: number
): number
{
  return attachmentAllowanceTokens(promptLimit - fixedPromptTokens)
}
