// src/mcp/tool-adapter.ts
// adapt MCP schemas & protocol results into Coral tools

import type {
  JsonSchemaValidator,
  jsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation'
import { Ajv, type Options as AjvOptions } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import type { JsonSchema } from '../types/inference.js'
import type { Tool, ToolArgumentValidation, ToolResult } from '../tools/tool.js'
import { ellipsize } from '../utils/ellipsize.js'
import {
  formatToolResult,
  MIN_SUBSTRING_SECRET_CHARS,
  redactDiagnostic,
  type McpOutputValidator,
} from './output.js'

const MAX_TOOL_DESCRIPTION_CHARS = 2_000
const MAX_VALIDATION_ERROR_CHARS = 2_000

export type McpResultBridge = (result: unknown) => ToolResult

export interface CreateMcpToolOptions
{
  name: string
  displayLabel: string
  description?: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  secretValues: readonly string[]
  invoke: (
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    bridgeResult: McpResultBridge
  ) => Promise<ToolResult>
}

function sanitizeDescription(
  description: string | undefined,
  secretValues: readonly string[]
): string
{
  const clean = redactDiagnostic(description ?? 'MCP tool', secretValues)
  return ellipsize(clean, MAX_TOOL_DESCRIPTION_CHARS)
}

// annotation strings never affect validation, so they are redacted for the model;
// other schema text must stay verbatim so the projection matches the raw validator
const ANNOTATION_KEYS = new Set([
  'description',
  'title',
  '$comment',
  'default',
  'examples',
])

// enum & const hold instance data the validator compares verbatim, so strings
// under annotation-named keys inside them are checked, not redacted
const INSTANCE_KEYS = new Set(['enum', 'const'])

// short values follow the redactor's rule that they are too common to be credentials,
// so only values at its substring threshold can make a schema position unsafe
function assertVerbatimSchemaText(
  text: string,
  secretValues: readonly string[]
): void
{
  const longValues = secretValues.filter(
    (value) => value.length >= MIN_SUBSTRING_SECRET_CHARS
  )
  if (redactDiagnostic(text, longValues) !== text)
  {
    throw new Error(
      'schema text outside annotations contains a forwarded environment value or control characters'
    )
  }
}

function schemaForModel(
  value: unknown,
  secretValues: readonly string[],
  key?: string,
  instance = false
): unknown
{
  if (typeof value === 'string')
  {
    if (!instance && key !== undefined && ANNOTATION_KEYS.has(key))
    {
      return ellipsize(
        redactDiagnostic(value, secretValues),
        MAX_TOOL_DESCRIPTION_CHARS
      )
    }
    assertVerbatimSchemaText(value, secretValues)
    return value
  }
  if (Array.isArray(value))
  {
    // examples items inherit the annotation key; other array items are structural
    const itemKey = key === 'examples' ? key : undefined
    return value.map((item) =>
      schemaForModel(item, secretValues, itemKey, instance)
    )
  }
  if (typeof value === 'object' && value !== null)
  {
    const result: Record<string, unknown> = Object.create(null)
    for (const [childKey, childValue] of Object.entries(value))
    {
      assertVerbatimSchemaText(childKey, secretValues)
      result[childKey] = schemaForModel(
        childValue,
        secretValues,
        childKey,
        instance || INSTANCE_KEYS.has(childKey)
      )
    }
    return result
  }
  return value
}

// the validator reads the dialect from the raw schema, so the model never needs $schema
function modelParameters(
  schema: JsonSchema,
  secretValues: readonly string[]
): JsonSchema
{
  const projected = { ...(schema as Record<string, unknown>) }
  delete projected.$schema
  return schemaForModel(projected, secretValues) as JsonSchema
}

// preserve the namespace shape expected by NodeNext for this CJS export
const addFormats =
  addFormatsModule as unknown as typeof addFormatsModule.default

// logger off keeps unknown-format warnings out of the TUI and stderr
const ajvOptions: AjvOptions = {
  logger: false,
  strict: false,
  validateFormats: true,
  validateSchema: false,
  allErrors: true,
}

type SchemaDialect = 'draft-07' | '2019-09' | '2020-12'

const createAjv: Record<SchemaDialect, () => Ajv> = {
  'draft-07': () => addFormats(new Ajv(ajvOptions)),
  '2019-09': () => addFormats(new Ajv2019(ajvOptions)),
  '2020-12': () => addFormats(new Ajv2020(ajvOptions)),
}

// anonymous schemas share one compiler per dialect
const sharedAjv: Record<SchemaDialect, Ajv> = {
  'draft-07': createAjv['draft-07'](),
  '2019-09': createAjv['2019-09'](),
  '2020-12': createAjv['2020-12'](),
}

// older drafts compile w/ draft-07 rules, which accept their array-form items;
// undeclared schemas follow MCP's 2020-12 default
function schemaDialect(schema: JsonSchema): SchemaDialect
{
  const declared = (schema as { $schema?: unknown }).$schema
  if (typeof declared !== 'string') return '2020-12'
  if (/draft-0[467]\b/.test(declared)) return 'draft-07'
  if (declared.includes('2019-09')) return '2019-09'
  return '2020-12'
}

// keep schema IDs local to each contract while honoring its declared dialect
function schemaValidator<T>(schema: JsonSchema): JsonSchemaValidator<T>
{
  const dialect = schemaDialect(schema)
  // any $id gets a private registry so reused IDs never collide across tools
  const identified = JSON.stringify(schema).includes('"$id"')
  const ajv = identified ? createAjv[dialect]() : sharedAjv[dialect]
  const validate = ajv.compile(schema as Record<string, unknown>)
  // drop the shared cache entry so retired tool contracts can be collected
  if (!identified) ajv.removeSchema(schema as Record<string, unknown>)
  return (input) =>
    validate(input)
      ? { valid: true, data: input as T, errorMessage: undefined }
      : {
          valid: false,
          data: undefined,
          errorMessage: ajv.errorsText(validate.errors),
        }
}

function inputValidator(
  toolName: string,
  schema: JsonSchema,
  secretValues: readonly string[]
): (args: Record<string, unknown>) => ToolArgumentValidation
{
  const validate = schemaValidator<Record<string, unknown>>(schema)

  return (args) =>
  {
    const result = validate(args)
    if (result.valid) return { ok: true, args: result.data }
    return {
      ok: false,
      error: `Invalid arguments for ${toolName}: ${ellipsize(redactDiagnostic(result.errorMessage, secretValues), MAX_VALIDATION_ERROR_CHARS)}. Fix the arguments & call the tool again.`,
    }
  }
}

export const permissiveSdkValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T>
  {
    return (input) => ({
      valid: true,
      data: input as T,
      errorMessage: undefined,
    })
  },
}

export function createMcpTool(options: CreateMcpToolOptions): Tool
{
  const validateArgs = inputValidator(
    options.name,
    options.inputSchema,
    options.secretValues
  )
  const validateOutput: McpOutputValidator | undefined = options.outputSchema
    ? schemaValidator<Record<string, unknown>>(options.outputSchema)
    : undefined
  const bridgeResult: McpResultBridge = (result) =>
    formatToolResult(result, validateOutput, options.secretValues)

  return {
    name: options.name,
    description: sanitizeDescription(options.description, options.secretValues),
    parameters: modelParameters(options.inputSchema, options.secretValues),
    display: { label: options.displayLabel },
    validateArgs,
    execute: (args, context) =>
      options.invoke(args, context?.signal, bridgeResult),
  }
}
