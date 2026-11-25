// src/providers/hosted-wire.ts
// sdk-free request and result policy shared by both hosted adapters

import {
  MALFORMED_TOOL_ARGUMENTS_KEY,
  type ChatRequest,
} from '../types/inference.js'

const DEFAULT_MAX_OUTPUT_TOKENS = 16_000
// reasoning cannot be fully disabled and its tokens count against the output
// cap, so tiny utility calls such as session titles run at the lowest effort
// with room left to reason before the visible answer
const SHORT_REQUEST_TOKENS = 1_024
const MIN_MAX_OUTPUT_TOKENS = 2_048

export const INTERRUPTED_TOOL_RESULT = 'Error: Tool call interrupted'

export interface HostedOutputBudget
{
  // sent as the provider's output token cap
  maxOutputTokens: number
  // true for tiny utility calls that should run at the lowest effort
  shortRequest: boolean
}

export function hostedOutputBudget(request: ChatRequest): HostedOutputBudget
{
  const requested =
    request.num_predict && request.num_predict > 0
      ? request.num_predict
      : DEFAULT_MAX_OUTPUT_TOKENS
  return {
    maxOutputTokens: Math.max(requested, MIN_MAX_OUTPUT_TOKENS),
    shortRequest: requested < SHORT_REQUEST_TOKENS,
  }
}

// stable id for a call that history stored without a provider id
export function syntheticCallId(messageIndex: number, callIndex: number)
{
  return `coral_${messageIndex}_${callIndex}`
}

// a tool result with no pending call to pair with travels as plain text
export function orphanToolResultText(
  toolName: string | undefined,
  content: string
): string
{
  return `Tool result (${toolName ?? 'unknown'}):\n${content}`
}

// a 4xx other than a timeout is refused before any tokens are billed
export function isBillingRejectedStatus(status: number | undefined): boolean
{
  return status !== undefined && status >= 400 && status < 500 && status !== 408
}

// a completed call whose arguments are not one JSON object keeps its place
// in the round but carries only the marker, so it gets a tool error unrun
export function malformedArguments(
  provider: string,
  toolName: string
): Record<string, unknown>
{
  return {
    [MALFORMED_TOOL_ARGUMENTS_KEY]: `${provider} sent malformed arguments for ${toolName}; the call was not run`,
  }
}
