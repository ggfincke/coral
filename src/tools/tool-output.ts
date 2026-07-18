// src/tools/tool-output.ts
// bound tool output before it enters the model context

import {
  MAX_ERROR_MESSAGE_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
} from '../utils/limits.js'
import { truncateToLineBoundary } from '../utils/truncate-output.js'
import { trimLeadingLowSurrogate } from '../utils/ellipsize.js'

export interface CapToolOutputOptions
{
  preserveTail?: boolean
}

// cap oversized tool output, keeping the head and noting what was dropped
export function capToolOutput(
  output: string,
  maxChars = MAX_TOOL_OUTPUT_CHARS,
  options: CapToolOutputOptions = {}
): string
{
  const budget = Math.max(0, Math.floor(maxChars))
  if (options.preserveTail && output.length > budget && budget >= 256)
  {
    // reserve marker space so the final model-facing value stays bounded
    const contentBudget = Math.max(budget - 192, 0)
    const tailBudget = Math.floor(contentBudget / 4)
    const headBudget = contentBudget - tailBudget
    const { head } = truncateToLineBoundary(output, headBudget)
    const tail = trimLeadingLowSurrogate(output.slice(-tailBudget))
    const omitted = Math.max(output.length - head.length - tail.length, 0)
    const redactionNote = output.includes('[redacted]')
      ? '\n[redacted] content present in omitted output'
      : ''
    return (
      `${head}\n\n[output truncated: ${omitted} of ${output.length} chars omitted` +
      ` — narrow the scope (e.g. diff a specific path) to see the rest]` +
      `${redactionNote}\n\n${tail}`
    )
  }

  const { head, omitted, truncated } = truncateToLineBoundary(output, budget)
  if (!truncated) return output

  return (
    `${head}\n\n[output truncated: ${omitted} of ${output.length} chars omitted` +
    ` — narrow the scope (e.g. diff a specific path) to see the rest]`
  )
}

// cap an oversized error string fed back to the model, keeping the head and
// noting what was dropped
export function capErrorMessage(error: string): string
{
  const { head, omitted, truncated } = truncateToLineBoundary(
    error,
    MAX_ERROR_MESSAGE_CHARS
  )
  if (!truncated) return error

  return `${head}\n[error truncated: ${omitted} of ${error.length} chars omitted]`
}
