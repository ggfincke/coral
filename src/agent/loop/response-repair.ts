// src/agent/loop/response-repair.ts
// recover text-emitted tool calls and stalled turns

import type { OllamaToolCall } from '../../types/inference.js'
import { tryParseJson } from '../../utils/json.js'
import { isPlainObject } from '../../utils/guards.js'
import { normalizeToolName } from '../../utils/tool-name.js'

// inject when a turn ends without a tool call, content, or thinking
export const STALL_NUDGE_MESSAGE =
  'Your last turn was empty. Call a tool to make progress, or give your final answer as plain text.'

// cap nudges before accepting an empty turn as final
export const MAX_STALL_NUDGES = 2

// cap corrective reprompts for unparseable call-shaped turns
export const MAX_REPROMPTS = 1

// inject when repair cannot recover a botched tool call
export const REPROMPT_MESSAGE =
  "That looked like a tool call, but it wasn't valid. Re-emit it as a proper " +
  'tool call with correct JSON, or give your final answer as plain text.'

// test wrapper tokens without mutating the global regular-expression cursor
const WRAPPER_TOKEN_PROBE = /<\|?\/?tool_call\|?>/i

// require a call-shaped key before treating content as a tool call
const ARGS_KEY_PROBE = /"(?:name|arguments|parameters)"\s*:/

// detect likely tool-call content without treating ordinary prose as a call
export function looksLikeAttemptedToolCall(
  content: string,
  toolNames: readonly string[]
): boolean
{
  if (WRAPPER_TOKEN_PROBE.test(content)) return true

  if (!content.includes('{') || !content.includes('}')) return false
  if (!ARGS_KEY_PROBE.test(content)) return false

  const known = new Set(toolNames.map(normalizeToolName))
  for (const match of content.matchAll(/"([^"]+)"/g))
  {
    if (known.has(normalizeToolName(match[1]!))) return true
  }
  return false
}

// strip template tokens that some models emit around text tool calls
const WRAPPER_TOKEN_PATTERN = /<\|?\/?tool_call\|?>/gi

// extract fenced code blocks with an optional language tag
const FENCED_BLOCK_PATTERN = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/g

// parse tool-call-shaped JSON without consuming ordinary JSON in prose
export function parseToolCallsFromContent(
  content: string,
  toolNames: readonly string[]
): OllamaToolCall[] | null
{
  const known = new Set(toolNames.map(normalizeToolName))
  const stripped = content.replace(WRAPPER_TOKEN_PATTERN, '\n')

  for (const group of collectCandidateGroups(stripped))
  {
    const calls: OllamaToolCall[] = []

    for (const text of group)
    {
      const parsed = tryParseJson(text)
      if (parsed === undefined) continue
      calls.push(...normalizeCalls(parsed, known))
    }

    if (calls.length > 0) return calls
  }

  return null
}

// try the whole content, fenced blocks, then a trailing object
function collectCandidateGroups(content: string): string[][]
{
  const trimmed = content.trim()
  const groups: string[][] = [[trimmed]]

  const fenced = [...trimmed.matchAll(FENCED_BLOCK_PATTERN)]
    .map((match) => match[1]!.trim())
    .filter((block) => block.length > 0)
  if (fenced.length > 0) groups.push(fenced)

  const trailing = extractTrailingJson(trimmed)
  if (trailing) groups.push([trailing])

  return groups
}

// find the largest JSON object that reaches the end of the content
function extractTrailingJson(content: string): string | null
{
  for (
    let i = content.indexOf('{');
    i !== -1;
    i = content.indexOf('{', i + 1)
  )
  {
    const candidate = content.slice(i)
    if (tryParseJson(candidate) !== undefined) return candidate
  }

  return null
}

// accept the common tool-call object shapes and arrays
function normalizeCalls(
  value: unknown,
  known: ReadonlySet<string>
): OllamaToolCall[]
{
  if (Array.isArray(value))
  {
    return value.flatMap((entry) => normalizeCalls(entry, known))
  }

  if (!isPlainObject(value)) return []

  if (Array.isArray(value.tool_calls))
  {
    return normalizeCalls(value.tool_calls, known)
  }

  const shape = isPlainObject(value.function) ? value.function : value
  const name = shape.name
  if (typeof name !== 'string' || !known.has(normalizeToolName(name)))
  {
    return []
  }

  const args = coerceArguments(shape.arguments ?? shape.parameters)
  if (args === null) return []

  return [{ type: 'function', function: { name, arguments: args } }]
}

// require arguments as an object or an encoded JSON object
function coerceArguments(value: unknown): Record<string, unknown> | null
{
  if (isPlainObject(value)) return value

  if (typeof value === 'string')
  {
    const parsed = tryParseJson(value)
    if (isPlainObject(parsed)) return parsed
  }

  return null
}
