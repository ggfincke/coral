// src/utils/limits.ts
// shared char/token budgets for bounding model-facing text

// rough token estimate: ~4 chars per token (conservative for English + code)
export const CHARS_PER_TOKEN = 4

// ~25k tokens — one huge tool result (e.g. a full `git diff` of a lockfile)
// would otherwise overflow the window or stall prefill
export const MAX_TOOL_OUTPUT_CHARS = 25_000 * CHARS_PER_TOKEN

// errors should stay short — a multi-KB stack or tool failure drowns the signal
// & can stall prefill on small models, so cap well below the output limit
export const MAX_ERROR_MESSAGE_CHARS = 2_000 * CHARS_PER_TOKEN
