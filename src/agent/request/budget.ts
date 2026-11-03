// src/agent/request/budget.ts
// model-request capacity, allocation, and overflow policy

import { CHARS_PER_TOKEN, MAX_TOOL_OUTPUT_CHARS } from '../../utils/limits.js'

export const MAX_RESPONSE_RESERVE_TOKENS = 16_384
export const MAX_SUMMARY_RESPONSE_RESERVE_TOKENS = 8_192
export const MAX_REQUEST_PROMPT_TOKENS = 32_768
export const RESPONSE_RESERVE_FRACTION = 0.125
export const MAX_HOSTED_RESPONSE_RESERVE_TOKENS = 64_000
export const ATTACHMENT_FLEXIBLE_SHARE = 0.5
export const MAX_ATTACHMENT_TOKENS = MAX_TOOL_OUTPUT_CHARS / CHARS_PER_TOKEN

export interface RequestBudgetCapacity
{
  // hosted windows bound the prompt alone; the response reserve sits on top
  hosted: boolean
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
  fileChanges: number
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

// retain failed accounting so callers can report the exact rejected snapshot
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
  'fileChanges',
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

// hosted APIs bill per token instead of stalling on local prefill, so their
// prompt is bounded by the pinned window alone and output by the model cap
export function requestBudgetCapacity(
  contextWindow: number,
  hostedOutputTokens?: number,
  maxPromptTokens = MAX_REQUEST_PROMPT_TOKENS,
  thinking = true
): RequestBudgetCapacity
{
  const window = normalizedWindow(contextWindow)
  if (hostedOutputTokens !== undefined)
  {
    const responseReserve = Math.max(
      1,
      Math.min(MAX_HOSTED_RESPONSE_RESERVE_TOKENS, hostedOutputTokens)
    )
    return {
      hosted: true,
      contextWindow: window,
      responseReserve,
      promptLimit: window,
      summaryResponseReserve: Math.min(
        MAX_SUMMARY_RESPONSE_RESERVE_TOKENS,
        responseReserve
      ),
      summaryPromptLimit: window,
    }
  }

  const fractionalReserve = Math.floor(window * RESPONSE_RESERVE_FRACTION)
  const responseReserve = Math.max(
    1,
    Math.min(
      MAX_RESPONSE_RESERVE_TOKENS,
      thinking && window >= 16_384
        ? Math.max(4_096, fractionalReserve)
        : fractionalReserve
    )
  )
  const localPromptCap =
    Number.isFinite(maxPromptTokens) && maxPromptTokens >= 1
      ? Math.floor(maxPromptTokens)
      : MAX_REQUEST_PROMPT_TOKENS
  const promptLimit = Math.max(
    0,
    Math.min(localPromptCap, window - responseReserve)
  )
  const summaryResponseReserve = Math.min(
    MAX_SUMMARY_RESPONSE_RESERVE_TOKENS,
    Math.max(1, fractionalReserve)
  )
  const summaryPromptLimit = Math.max(
    0,
    Math.min(localPromptCap, window - summaryResponseReserve)
  )

  return {
    hosted: false,
    contextWindow: window,
    responseReserve,
    promptLimit,
    summaryResponseReserve,
    summaryPromptLimit,
  }
}

export function createRequestBudgetBreakdown(
  contextWindow: number,
  input: Partial<RequestBudgetCategories>,
  hostedOutputTokens?: number,
  maxPromptTokens?: number,
  thinking = true
): RequestBudgetBreakdown
{
  const capacity = requestBudgetCapacity(
    contextWindow,
    hostedOutputTokens,
    maxPromptTokens,
    thinking
  )
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
  const contextLimit = capacity.hosted
    ? capacity.contextWindow + capacity.responseReserve
    : capacity.contextWindow
  const promptOverflow = Math.max(promptTokens - capacity.promptLimit, 0)
  const contextOverflow = Math.max(totalTokens - contextLimit, 0)
  const overflowTokens = Math.max(promptOverflow, contextOverflow)

  return {
    ...capacity,
    categories: Object.freeze(categories),
    fixedPromptTokens,
    promptTokens,
    totalTokens,
    remainingPromptTokens: Math.max(capacity.promptLimit - promptTokens, 0),
    remainingContextTokens: Math.max(contextLimit - totalTokens, 0),
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
