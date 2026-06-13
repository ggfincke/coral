// src/agent/tool-output.ts
// bound tool output before it enters the model context

import { CHARS_PER_TOKEN } from './compaction.js'

// ~25k tokens — one huge tool result (e.g. a full `git diff` of a lockfile)
// would otherwise overflow the window or stall prefill
export const MAX_TOOL_OUTPUT_CHARS = 25_000 * CHARS_PER_TOKEN

// cap oversized tool output, keeping the head & noting how much was dropped
export function capToolOutput(output: string): string
{
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output

  // cut back to a line boundary so the model never sees a half-line
  const slice = output.slice(0, MAX_TOOL_OUTPUT_CHARS)
  const lastNewline = slice.lastIndexOf('\n')
  const head = lastNewline > 0 ? slice.slice(0, lastNewline) : slice
  const omitted = output.length - head.length

  return (
    `${head}\n\n[output truncated: ${omitted} of ${output.length} chars omitted` +
    ` — narrow the scope (e.g. diff a specific path) to see the rest]`
  )
}
