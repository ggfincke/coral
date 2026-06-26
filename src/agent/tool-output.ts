// src/agent/tool-output.ts
// bound tool output before it enters the model context

import {
  MAX_ERROR_MESSAGE_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
} from '../utils/limits.js'
import { truncateToLineBoundary } from '../utils/truncate-output.js'

// cap oversized tool output, keeping the head & noting how much was dropped
export function capToolOutput(output: string): string
{
  const { head, omitted, truncated } = truncateToLineBoundary(
    output,
    MAX_TOOL_OUTPUT_CHARS
  )
  if (!truncated) return output

  return (
    `${head}\n\n[output truncated: ${omitted} of ${output.length} chars omitted` +
    ` — narrow the scope (e.g. diff a specific path) to see the rest]`
  )
}

// cap an oversized error string fed back to the model, keeping the head &
// noting how much was dropped (mirrors capToolOutput, w/o the scope hint)
export function capErrorMessage(error: string): string
{
  const { head, omitted, truncated } = truncateToLineBoundary(
    error,
    MAX_ERROR_MESSAGE_CHARS
  )
  if (!truncated) return error

  return `${head}\n[error truncated: ${omitted} of ${error.length} chars omitted]`
}
