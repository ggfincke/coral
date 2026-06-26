// src/agent/tool-validation.ts
// validate & coerce tool args against the tool's JSON schema pre-dispatch

import type { Tool } from '../tools/index.js'
import { paramEntries } from '../types/inference.js'
import { ellipsize } from '../utils/ellipsize.js'
import { tryParseJson } from '../utils/json.js'
import { isPlainObject } from '../utils/guards.js'

export type ValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string }

// keep validation feedback model-friendly — a long list of problems makes weak
// models halt or hallucinate, so show the first few & summarize the rest
const MAX_VALIDATION_PROBLEMS = 8

// check args against the schema, coercing common weak-model slips
// ("2" -> 2, "true" -> true) — failures return a model-friendly error
export function validateToolArgs(
  tool: Tool,
  args: Record<string, unknown>
): ValidationResult
{
  const problems: string[] = []
  const coerced: Record<string, unknown> = { ...args }
  const entries = paramEntries(tool.parameters)
  const schemaByName = new Map(entries.map((e) => [e.name, e.schema]))

  // treat null/undefined as omitted so optional params w/ null don't fail
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
      error: `Invalid arguments for ${tool.name}: ${summarizeProblems(problems)}. Fix the arguments & call the tool again.`,
    }
  }

  return { ok: true, args: coerced }
}

// cap the problem list at MAX_VALIDATION_PROBLEMS, summarizing the overflow so
// the trailing fix instruction is never severed by a downstream char cap
function summarizeProblems(problems: string[]): string
{
  if (problems.length <= MAX_VALIDATION_PROBLEMS) return problems.join('; ')
  const shown = problems.slice(0, MAX_VALIDATION_PROBLEMS).join('; ')
  return `${shown}; plus ${problems.length - MAX_VALIDATION_PROBLEMS} more`
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
      // unknown schema type — pass through rather than block the call
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
