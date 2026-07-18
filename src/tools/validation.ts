// src/tools/validation.ts
// validate and coerce tool args against the tool's JSON schema before dispatch

import type { Tool, ToolArgumentValidation } from './tool.js'
import { paramEntries } from '../types/inference.js'
import { ellipsize } from '../utils/ellipsize.js'
import { tryParseJson } from '../utils/json.js'
import { isPlainObject } from '../utils/guards.js'

// keep validation feedback model-friendly so long error lists do not distract
// the model
const MAX_VALIDATION_PROBLEMS = 8

// check args against the schema and coerce unambiguous string values
export function validateToolArgs(
  tool: Tool,
  args: Record<string, unknown>
): ToolArgumentValidation
{
  if (tool.validateArgs) return tool.validateArgs(args)

  const problems: string[] = []
  const coerced: Record<string, unknown> = { ...args }
  const entries = paramEntries(tool.parameters)
  const schemaByName = new Map(entries.map((e) => [e.name, e.schema]))

  // treat null and undefined as omitted so optional params with null do not fail
  for (const [key, value] of Object.entries(coerced))
  {
    if (value === null || value === undefined) delete coerced[key]
  }

  for (const { name, required } of entries)
  {
    if (required && !(name in coerced))
    {
      problems.push(`missing required parameter '${name}'`)
    }
  }

  for (const [key, value] of Object.entries(coerced))
  {
    const schema = schemaByName.get(key)
    // tolerate extra params because tools read named fields and ignore the rest
    if (!schema) continue

    if (typeof schema === 'boolean') continue
    if (typeof schema.type !== 'string') continue
    const itemType =
      typeof schema.items === 'object' &&
      schema.items !== null &&
      typeof schema.items.type === 'string'
        ? schema.items.type
        : undefined
    const result = coerceValue(value, schema.type, itemType)
    if (!result.ok)
    {
      problems.push(
        `parameter '${key}' must be ${article(schema.type)} (got ${describe(value)})`
      )
      continue
    }

    coerced[key] = result.value

    if (
      schema.enum &&
      !schema.enum.some((item) => Object.is(item, result.value))
    )
    {
      problems.push(
        `parameter '${key}' must be one of: ${schema.enum.join(', ')}`
      )
    }
  }

  if (problems.length > 0)
  {
    return {
      ok: false,
      error: `Invalid arguments for ${tool.name}: ${summarizeProblems(problems)}. Fix the arguments & call the tool again.`,
    }
  }

  return { ok: true, args: coerced }
}

// cap the problem list so the trailing fix instruction survives downstream
// character limits
function summarizeProblems(problems: string[]): string
{
  if (problems.length <= MAX_VALIDATION_PROBLEMS) return problems.join('; ')
  const shown = problems.slice(0, MAX_VALIDATION_PROBLEMS).join('; ')
  return `${shown}; plus ${problems.length - MAX_VALIDATION_PROBLEMS} more`
}

type CoerceResult = { ok: true; value: unknown } | { ok: false }

// coerce a value toward the schema type and reject ambiguous forms
function coerceValue(
  value: unknown,
  type: string,
  itemType?: string
): CoerceResult
{
  switch (type)
  {
    case 'string':
      if (typeof value === 'string') return { ok: true, value }
      if (typeof value === 'number' || typeof value === 'boolean')
      {
        return { ok: true, value: String(value) }
      }
      return { ok: false }

    case 'number':
    case 'integer':
    {
      const num =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : NaN
      if (!Number.isFinite(num)) return { ok: false }
      if (type === 'integer' && !Number.isInteger(num)) return { ok: false }
      return { ok: true, value: num }
    }

    case 'boolean':
      if (typeof value === 'boolean') return { ok: true, value }
      if (value === 'true') return { ok: true, value: true }
      if (value === 'false') return { ok: true, value: false }
      return { ok: false }

    case 'array':
    {
      const arr = typeof value === 'string' ? tryParseJson(value) : value
      if (!Array.isArray(arr)) return { ok: false }
      if (itemType)
      {
        const items: unknown[] = []
        for (const item of arr)
        {
          const result = coerceValue(item, itemType)
          if (!result.ok) return { ok: false }
          items.push(result.value)
        }
        return { ok: true, value: items }
      }
      return { ok: true, value: arr }
    }

    case 'object':
    {
      const obj = typeof value === 'string' ? tryParseJson(value) : value
      if (!isPlainObject(obj)) return { ok: false }
      return { ok: true, value: obj }
    }

    default:
      // pass through unknown schema types instead of blocking the call
      return { ok: true, value }
  }
}

function article(type: string): string
{
  return type === 'integer' || type === 'array' || type === 'object'
    ? `an ${type}`
    : `a ${type}`
}

function describe(value: unknown): string
{
  if (typeof value === 'string') return `string "${ellipsize(value, 40)}"`
  if (Array.isArray(value)) return 'an array'
  if (value === null) return 'null'
  return `${typeof value} ${ellipsize(JSON.stringify(value) ?? String(value), 40)}`
}
