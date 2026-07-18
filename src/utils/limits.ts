// src/utils/limits.ts
// shared char/token budgets for bounding model-facing text

// rough token estimate: ~4 chars per token (conservative for English + code)
export const CHARS_PER_TOKEN = 4

export interface Utf8TokenEstimate
{
  utf8Bytes: number
  tokens: number
}

// estimate model-facing text from its encoded size so non-ascii input cannot
// consume more bytes while appearing artificially cheap to the allocator
export function estimateUtf8Tokens(value: string): Utf8TokenEstimate
{
  const utf8Bytes = Buffer.byteLength(value, 'utf-8')
  return {
    utf8Bytes,
    tokens: Math.ceil(utf8Bytes / CHARS_PER_TOKEN),
  }
}

// estimate an already-allowlisted semantic request value including its object
// framing; callers must project away ui/internal fields before reaching here
export function estimateModelRequestValue(value: unknown): Utf8TokenEstimate
{
  return estimateUtf8Tokens(JSON.stringify(value) ?? '')
}

// ~25k tokens — one huge tool result (e.g. a full `git diff` of a lockfile)
// would otherwise overflow the window or stall prefill
export const MAX_TOOL_OUTPUT_CHARS = 25_000 * CHARS_PER_TOKEN

// errors should stay short — a multi-KB stack or tool failure drowns the signal
// & can stall prefill on small models, so cap well below the output limit
export const MAX_ERROR_MESSAGE_CHARS = 2_000 * CHARS_PER_TOKEN
