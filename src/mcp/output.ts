// src/mcp/output.ts
// sanitize & bound MCP tool output for model consumption

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation'
import stripAnsi from 'strip-ansi'
import type { ToolResult } from '../tools/tool.js'
import { ellipsize, trimTrailingHighSurrogate } from '../utils/ellipsize.js'
import { MAX_TOOL_OUTPUT_CHARS } from '../utils/limits.js'

const MAX_STRUCTURED_CONTENT_CHARS = 80_000
const MAX_STRUCTURED_CONTENT_DEPTH = 20
const MAX_STRUCTURED_COLLECTION_ITEMS = 200
const MAX_TOOL_RESULT_ERROR_CHARS = 2_000
const MCP_OUTPUT_SCAN_CHARS = 16_384

function sanitizeDiagnostic(text: string): string
{
  const clean = stripAnsi(text)
  const parts: string[] = []
  let chunk = ''
  for (const character of clean)
  {
    const code = character.codePointAt(0) ?? 0
    chunk +=
      code <= 8 || code === 11 || code === 12 || code === 127
        ? '�'
        : code >= 14 && code <= 31
          ? '�'
          : character
    if (chunk.length >= 4_096)
    {
      parts.push(chunk)
      chunk = ''
    }
  }
  if (chunk) parts.push(chunk)
  return parts.join('')
}

function serializedSecret(value: string): string
{
  const json = JSON.stringify(value)
  return json.length >= 2 ? json.slice(1, -1) : ''
}

export function normalizedSecrets(secretValues: readonly string[]): string[]
{
  const values = new Set<string>()
  for (const value of secretValues)
  {
    if (!value) continue
    const clean = sanitizeDiagnostic(value)
    for (const candidate of [value, clean, serializedSecret(value)])
    {
      if (candidate) values.add(candidate)
    }
  }
  return [...values].sort((left, right) => right.length - left.length)
}

export function redactDiagnostic(
  text: string,
  secretValues: readonly string[]
): string
{
  let result = sanitizeDiagnostic(text)
  for (const value of normalizedSecrets(secretValues))
  {
    result =
      value.length >= 4
        ? result.replaceAll(value, '[redacted]')
        : redactShortValue(result, value)
  }
  return result
}

function isTokenCharacter(value: string | undefined): boolean
{
  if (!value) return false
  const code = value.codePointAt(0) ?? 0
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  )
}

function redactShortValue(text: string, value: string): string
{
  let result = ''
  let cursor = 0
  while (cursor < text.length)
  {
    const index = text.indexOf(value, cursor)
    if (index < 0)
    {
      result += text.slice(cursor)
      break
    }

    const before = index > 0 ? text[index - 1] : undefined
    const after = text[index + value.length]
    if (!isTokenCharacter(before) && !isTokenCharacter(after))
    {
      result += text.slice(cursor, index) + '[redacted]'
    }
    else
    {
      result += text.slice(cursor, index + value.length)
    }
    cursor = index + value.length
  }
  return result
}

type AnsiScanState = 'text' | 'escape' | 'csi' | 'string' | 'string_escape'

// bound model output while scanning for ANSI controls and forwarded secrets
class McpOutputAccumulator
{
  private readonly secrets: string[]
  private readonly redactionLookbehind: number
  private ansiState: AnsiScanState = 'text'
  private redactionTail = ''
  private previousSourceCharacter: string | undefined
  private outputParts: string[] = []
  private outputHeadLength = 0
  private totalOutputLength = 0
  private lastNewline = -1
  private started = false

  constructor(secretValues: readonly string[])
  {
    this.secrets = normalizedSecrets(secretValues)
    this.redactionLookbehind = Math.max(
      ...this.secrets.map((value) => value.length + 1),
      1
    )
  }

  addPart(...segments: string[]): void
  {
    if (segments.every((segment) => segment.length === 0)) return
    if (this.started) this.writeRaw('\n\n')
    this.started = true
    for (const segment of segments)
    {
      this.writeRaw(segment)
    }
  }

  finish(): string
  {
    this.redactSanitized('', true)
    if (this.totalOutputLength === 0)
    {
      this.appendOutput('(MCP tool returned no supported content)')
    }

    const retained = this.outputParts.join('')
    if (this.totalOutputLength <= MAX_TOOL_OUTPUT_CHARS) return retained

    const boundary = this.lastNewline > 0 ? this.lastNewline : retained.length
    const head = trimTrailingHighSurrogate(retained.slice(0, boundary))
    const omitted = this.totalOutputLength - head.length
    return (
      `${head}\n\n[output truncated: ${omitted} of ${this.totalOutputLength} chars omitted` +
      ` — narrow the scope (e.g. diff a specific path) to see the rest]`
    )
  }

  private writeRaw(text: string): void
  {
    for (
      let offset = 0;
      offset < text.length;
      offset += MCP_OUTPUT_SCAN_CHARS
    )
    {
      const sanitized = this.sanitizeRawChunk(
        text.slice(offset, offset + MCP_OUTPUT_SCAN_CHARS)
      )
      if (sanitized) this.redactSanitized(sanitized, false)
    }
  }

  private sanitizeRawChunk(text: string): string
  {
    const parts: string[] = []
    let plainStart = this.ansiState === 'text' ? 0 : -1

    for (let index = 0; index < text.length; index++)
    {
      const character = text[index]!
      const code = text.charCodeAt(index)
      if (this.ansiState !== 'text')
      {
        if (this.ansiState === 'escape')
        {
          if (character === '[') this.ansiState = 'csi'
          else if (character === ']' || 'PX^_'.includes(character))
          {
            this.ansiState = 'string'
          }
          else this.ansiState = 'text'
        }
        else if (this.ansiState === 'csi')
        {
          if (code >= 0x40 && code <= 0x7e) this.ansiState = 'text'
          else if (code === 0x1b) this.ansiState = 'escape'
        }
        else if (this.ansiState === 'string')
        {
          if (code === 0x07 || code === 0x9c) this.ansiState = 'text'
          else if (code === 0x1b) this.ansiState = 'string_escape'
        }
        else if (character === '\\') this.ansiState = 'text'
        else if (code !== 0x1b) this.ansiState = 'string'

        if (this.ansiState === 'text') plainStart = index + 1
        continue
      }

      const replacesControl =
        code !== 0x1b &&
        (code <= 8 ||
          code === 11 ||
          code === 12 ||
          code === 127 ||
          (code >= 14 && code <= 31))
      const beginsAnsi =
        code === 0x1b ||
        code === 0x9b ||
        [0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)
      if (!replacesControl && !beginsAnsi) continue

      if (plainStart >= 0 && plainStart < index)
      {
        parts.push(text.slice(plainStart, index))
      }
      if (replacesControl)
      {
        parts.push('�')
        plainStart = index + 1
        continue
      }
      if (code === 0x1b)
      {
        this.ansiState = 'escape'
      }
      else if (code === 0x9b)
      {
        this.ansiState = 'csi'
      }
      else
      {
        this.ansiState = 'string'
      }
      plainStart = -1
    }

    if (
      this.ansiState === 'text' &&
      plainStart >= 0 &&
      plainStart < text.length
    )
    {
      parts.push(text.slice(plainStart))
    }
    return parts.join('')
  }

  private redactSanitized(text: string, final: boolean): void
  {
    const combined = this.redactionTail + text
    const processBefore = final
      ? combined.length
      : Math.max(combined.length - this.redactionLookbehind, 0)
    let cursor = 0

    while (cursor < processBefore)
    {
      const match = this.nextSecretMatch(combined, cursor, processBefore)
      if (!match) break
      this.appendOutput(combined.slice(cursor, match.index))
      this.appendOutput('[redacted]')
      cursor = match.index + match.secret.length
    }

    const processed = Math.max(cursor, processBefore)
    this.appendOutput(combined.slice(cursor, processed))
    if (processed > 0)
    {
      this.previousSourceCharacter = combined[processed - 1]
    }
    this.redactionTail = combined.slice(processed)
  }

  private nextSecretMatch(
    text: string,
    start: number,
    processBefore: number
  ): { index: number; secret: string } | undefined
  {
    let best: { index: number; secret: string } | undefined
    for (const secret of this.secrets)
    {
      let index = text.indexOf(secret, start)
      while (index >= 0 && index < processBefore)
      {
        const before =
          index > 0 ? text[index - 1] : this.previousSourceCharacter
        const after = text[index + secret.length]
        if (
          secret.length >= 4 ||
          (!isTokenCharacter(before) && !isTokenCharacter(after))
        )
        {
          if (!best || index < best.index) best = { index, secret }
          break
        }
        index = text.indexOf(secret, index + 1)
      }
    }
    return best
  }

  private appendOutput(text: string): void
  {
    if (!text) return
    this.totalOutputLength += text.length
    const remaining = MAX_TOOL_OUTPUT_CHARS - this.outputHeadLength
    if (remaining <= 0) return

    const retained = text.slice(0, remaining)
    const newline = retained.lastIndexOf('\n')
    if (newline >= 0) this.lastNewline = this.outputHeadLength + newline
    this.outputParts.push(retained)
    this.outputHeadLength += retained.length
  }
}

interface JsonBudget
{
  remaining: number
  truncated: boolean
}

const TRUNCATION_MARKER_COST = '"[truncated]"'.length

// account for the indentation and separators emitted for each pretty-printed item
function serializedItemOverhead(depth: number): number
{
  return 2 * (depth + 1) + 4
}

// charge serialization overhead alongside scalar contents so deep nesting stays
// within MAX_STRUCTURED_CONTENT_CHARS
function boundedJsonValue(
  value: unknown,
  budget: JsonBudget,
  depth = 0
): unknown
{
  if (budget.remaining <= 0 || depth > MAX_STRUCTURED_CONTENT_DEPTH)
  {
    budget.truncated = true
    budget.remaining -= TRUNCATION_MARKER_COST
    return '[truncated]'
  }

  if (typeof value === 'string')
  {
    const length = Math.min(value.length, budget.remaining)
    budget.remaining -= length + 2
    if (length < value.length) budget.truncated = true
    return ellipsize(value, length)
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
  {
    budget.remaining -= String(value).length
    return value
  }
  if (Array.isArray(value))
  {
    // account for bracket lines and indentation
    budget.remaining -= 2 * depth + 4
    const result: unknown[] = []
    for (const item of value.slice(0, MAX_STRUCTURED_COLLECTION_ITEMS))
    {
      if (budget.remaining <= 0) break
      budget.remaining -= serializedItemOverhead(depth)
      result.push(boundedJsonValue(item, budget, depth + 1))
    }
    if (result.length < value.length) budget.truncated = true
    return result
  }
  if (typeof value === 'object')
  {
    const object = value as Record<string, unknown>
    budget.remaining -= 2 * depth + 4
    const result: Record<string, unknown> = Object.create(null)
    let items = 0
    for (const key in object)
    {
      if (!Object.hasOwn(object, key)) continue
      if (items >= MAX_STRUCTURED_COLLECTION_ITEMS || budget.remaining <= 0)
      {
        budget.truncated = true
        break
      }
      const keyLength = Math.min(key.length, budget.remaining)
      const boundedKey = ellipsize(key, keyLength)
      // include key quotes and the ': ' separator in item overhead
      budget.remaining -= keyLength + serializedItemOverhead(depth) + 3
      if (keyLength < key.length) budget.truncated = true
      result[boundedKey] = boundedJsonValue(object[key], budget, depth + 1)
      items += 1
    }
    return result
  }

  budget.truncated = true
  return `[unsupported ${typeof value}]`
}

function formatStructuredContent(value: Record<string, unknown>): string
{
  const budget: JsonBudget = {
    remaining: MAX_STRUCTURED_CONTENT_CHARS,
    truncated: false,
  }
  const bounded = boundedJsonValue(value, budget)
  const label = budget.truncated
    ? '[structured content truncated]'
    : '[structured content]'
  return `${label}\n${JSON.stringify(bounded, null, 2)}`
}

function formatUnsupportedContent(
  content: CallToolResult['content'][number]
): string
{
  switch (content.type)
  {
    case 'image':
      return `[unsupported MCP image content: ${content.mimeType}]`
    case 'audio':
      return `[unsupported MCP audio content: ${content.mimeType}]`
    case 'resource':
      return `[unsupported MCP binary resource: ${content.resource.uri}]`
    case 'resource_link':
      return `[unsupported MCP resource link: ${content.uri}]`
    default:
      return '[unsupported MCP content]'
  }
}

function addMcpContent(
  output: McpOutputAccumulator,
  content: CallToolResult['content'][number]
): void
{
  if (content.type === 'text')
  {
    output.addPart(content.text)
    return
  }
  if (content.type === 'resource' && 'text' in content.resource)
  {
    output.addPart(
      `[MCP embedded resource: ${content.resource.uri}]\n`,
      content.resource.text
    )
    return
  }
  output.addPart(formatUnsupportedContent(content))
}

export type McpOutputValidator = JsonSchemaValidator<Record<string, unknown>>

export function formatToolResult(
  result: unknown,
  validateOutput: McpOutputValidator | undefined,
  secretValues: readonly string[]
): ToolResult
{
  if (
    typeof result !== 'object' ||
    result === null ||
    !('content' in result) ||
    !Array.isArray(result.content)
  )
  {
    return {
      output: '',
      error: 'MCP server returned an unsupported legacy tool result',
    }
  }

  const callResult = result as CallToolResult
  if (validateOutput && !callResult.isError)
  {
    if (!callResult.structuredContent)
    {
      return {
        output: '',
        error:
          'MCP tool declared an output schema but returned no structured content',
      }
    }
    const validation = validateOutput(callResult.structuredContent)
    if (!validation.valid)
    {
      return {
        output: '',
        error: `MCP structured output failed validation: ${ellipsize(redactDiagnostic(validation.errorMessage, secretValues), MAX_TOOL_RESULT_ERROR_CHARS)}`,
      }
    }
  }

  const accumulator = new McpOutputAccumulator(secretValues)
  for (const content of callResult.content)
  {
    addMcpContent(accumulator, content)
  }

  if (callResult.structuredContent)
  {
    accumulator.addPart(formatStructuredContent(callResult.structuredContent))
  }

  const output = accumulator.finish()
  return callResult.isError
    ? {
        output,
        error: `MCP server reported a tool error: ${ellipsize(output, MAX_TOOL_RESULT_ERROR_CHARS)}`,
      }
    : { output }
}
