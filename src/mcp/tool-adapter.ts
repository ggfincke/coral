// src/mcp/tool-adapter.ts
// adapt MCP schemas & protocol results into Coral tools

import type {
  JsonSchemaValidator,
  jsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation'
import { Ajv, type Options as AjvOptions } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import type { JsonSchema } from '../types/inference.js'
import type { Tool, ToolArgumentValidation, ToolResult } from '../tools/tool.js'
import { ellipsize } from '../utils/ellipsize.js'
import {
  formatToolResult,
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

function schemaForModel(
  value: unknown,
  secretValues: readonly string[],
  key?: string
): unknown
{
  if (typeof value === 'string')
  {
    const clean = redactDiagnostic(value, secretValues)
    if (key === 'description' || key === 'title' || key === '$comment')
    {
      return ellipsize(clean, MAX_TOOL_DESCRIPTION_CHARS)
    }
    return clean
  }
  if (Array.isArray(value))
  {
    return value.map((item) => schemaForModel(item, secretValues))
  }
  if (typeof value === 'object' && value !== null)
  {
    const result: Record<string, unknown> = Object.create(null)
    for (const [childKey, childValue] of Object.entries(value))
    {
      const cleanKey = redactDiagnostic(childKey, secretValues)
      result[cleanKey] = schemaForModel(childValue, secretValues, childKey)
    }
    return result
  }
  return value
}

// preserve the namespace shape expected by NodeNext for this CJS export
const addFormats =
  addFormatsModule as unknown as typeof addFormatsModule.default

const ajvOptions: AjvOptions = {
  strict: false,
  validateFormats: true,
  validateSchema: false,
  allErrors: true,
}

// compile each schema under its declared dialect because SDK servers may use draft-07
const ajv2020 = addFormats(new Ajv2020(ajvOptions))
const ajvDraft07 = addFormats(new Ajv(ajvOptions))

function schemaValidator<T>(schema: JsonSchema): JsonSchemaValidator<T>
{
  const declared = (schema as { $schema?: unknown }).$schema
  const ajv =
    typeof declared === 'string' && declared.includes('draft-07')
      ? ajvDraft07
      : ajv2020
  const validate = ajv.compile(schema as Record<string, unknown>)
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
    parameters: schemaForModel(
      options.inputSchema,
      options.secretValues
    ) as JsonSchema,
    display: { label: options.displayLabel },
    validateArgs,
    execute: (args, context) =>
      options.invoke(args, context?.signal, bridgeResult),
  }
}
