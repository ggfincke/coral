// src/agent/tool-validation.ts
// validate & coerce tool args against the tool's JSON schema pre-dispatch

import type { Tool } from '../tools/index.js'

export type ValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string }

// check args against the schema, coercing common weak-model slips
// ("2" -> 2, "true" -> true) — failures return a model-friendly error
export function validateToolArgs(
  tool: Tool,
  args: Record<string, unknown>
): ValidationResult
{
  const problems: string[] = []
  const coerced: Record<string, unknown> = { ...args }
  const { properties, required = [] } = tool.parameters

  // treat null/undefined as omitted so optional params w/ null don't fail
  for (const [key, value] of Object.entries(coerced))
  {
    if (value === null || value === undefined) delete coerced[key]
  }

  for (const key of required)
  {
    if (!(key in coerced))
    {
      problems.push(`missing required parameter '${key}'`)
    }
  }

  for (const [key, value] of Object.entries(coerced))
  {
    const schema = properties[key]
    // tolerate extra params — tools read named fields & ignore the rest
    if (!schema) continue

    const result = coerceValue(value, schema.type, schema.items?.type)
    if (!result.ok)
    {
      problems.push(
        `parameter '${key}' must be ${article(schema.type)} (got ${describe(value)})`
      )
      continue
    }

    coerced[key] = result.value

    if (schema.enum && !schema.enum.includes(String(result.value)))
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
      error: `Invalid arguments for ${tool.name}: ${problems.join('; ')}. Fix the arguments & call the tool again.`,
    }
  }

  return { ok: true, args: coerced }
}

type CoerceResult = { ok: true; value: unknown } | { ok: false }

// coerce a value toward the schema type — accepts what already matches,
// converts unambiguous string forms, rejects everything else
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
      const arr = typeof value === 'string' ? tryParseJsonArray(value) : value
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
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      )
      {
        return { ok: true, value }
      }
      return { ok: false }

    default:
      // unknown schema type — pass through rather than block the call
      return { ok: true, value }
  }
}

function tryParseJsonArray(text: string): unknown
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

function article(type: string): string
{
  return type === 'integer' || type === 'array' || type === 'object'
    ? `an ${type}`
    : `a ${type}`
}

function describe(value: unknown): string
{
  if (typeof value === 'string') return `string "${truncate(value)}"`
  if (Array.isArray(value)) return 'an array'
  if (value === null) return 'null'
  return `${typeof value} ${truncate(JSON.stringify(value) ?? String(value))}`
}

function truncate(text: string): string
{
  return text.length > 40 ? `${text.slice(0, 40)}...` : text
}
