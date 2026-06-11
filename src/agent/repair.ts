// src/agent/repair.ts
// recover tool calls emitted as text & nudge stalled turns

import type { OllamaToolCall } from '../types/inference.js'

// injected when a turn ends w/ no tool call, no content, & no thinking
export const STALL_NUDGE_MESSAGE =
  'Your last turn was empty. Call a tool to make progress, or give your final answer as plain text.'

// max nudges per run() before accepting the empty turn as final
export const MAX_STALL_NUDGES = 2

// lowercase & strip separators so Read_File / READFILE match read_file
export function normalizeToolName(name: string): string
{
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// leaked template tokens some models emit around text tool calls
// (e.g. <|tool_call|> from Gemma templates) — strip before JSON extraction
const WRAPPER_TOKEN_PATTERN = /<\|?\/?tool_call\|?>/gi

// fenced code blocks w/ optional language tag
const FENCED_BLOCK_PATTERN = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/g

// parse tool-call-shaped JSON out of assistant text content
// returns null unless at least one call names a known tool & carries an
// arguments object — the guard against eating ordinary JSON in prose
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

// candidate JSON strings in priority order: whole content, fenced blocks,
// then a trailing object (the narrate-then-emit-JSON pattern)
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

// largest JSON object that runs to the end of the content
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

function tryParseJson(text: string): unknown
{
  try
  {
    return JSON.parse(text)
  }
  catch
  {
    return undefined
  }
}

// accept {name, arguments}, {function: {...}}, {tool_calls: [...]}, & arrays
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

// arguments must be present as an object (or a JSON string encoding one)
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

function isPlainObject(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
