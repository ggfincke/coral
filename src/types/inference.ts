// src/types/inference.ts
// shared inference message, tool, and model metadata types

import type { AttachmentReport } from './attachments.js'

export type JsonSchemaType =
  'array' | 'boolean' | 'integer' | 'null' | 'number' | 'object' | 'string'

export type JsonSchemaNode = boolean | JsonSchemaObject

export interface JsonSchemaObject
{
  type?: JsonSchemaType | JsonSchemaType[]
  description?: string
  enum?: unknown[]
  const?: unknown
  default?: unknown
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: JsonSchemaNode
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
  allOf?: JsonSchemaNode[]
  not?: JsonSchemaNode
  $ref?: string
  $defs?: Record<string, JsonSchemaNode>
  [keyword: string]: unknown
}

export interface JsonSchema extends JsonSchemaObject
{
  type: 'object'
  properties?: Record<string, JsonSchemaNode>
}

interface JsonSchemaParamEntry
{
  name: string
  schema: JsonSchemaNode
  required: boolean
}

// pair schema properties with the required set for validators and prompt rendering
export function paramEntries(schema: JsonSchema): JsonSchemaParamEntry[]
{
  const requiredSet = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([name, propSchema]) => ({
    name,
    schema: propSchema,
    required: requiredSet.has(name),
  }))
}

export function jsonSchemaTypeLabel(schema: JsonSchemaNode): string
{
  if (typeof schema === 'boolean') return schema ? 'any' : 'never'
  if (Array.isArray(schema.type)) return schema.type.join(' | ')
  if (schema.type) return schema.type
  if (schema.enum) return 'enum'
  if (schema.anyOf || schema.oneOf) return 'value'
  return 'unknown'
}

// exact semantic message shape allowed in a model request
export interface ModelRequestMessage
{
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  tool_name?: string
  tool_calls?: OllamaToolCall[]
}

// stored conversation message; display metadata belongs to persistence/ui only
export interface OllamaMessage extends ModelRequestMessage
{
  displayContent?: string
  attachmentReport?: AttachmentReport
}

export interface OllamaToolCall
{
  type?: 'function'
  function: {
    index?: number
    name: string
    arguments: Record<string, unknown>
  }
}

export interface OllamaTool
{
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JsonSchema
  }
}

export interface ChatRequest
{
  model: string
  messages: ModelRequestMessage[]
  tools?: OllamaTool[]
  think?: boolean | 'low' | 'medium' | 'high'
  keep_alive?: string | number
  // pin the context window sent as options.num_ctx so Ollama does not reload the
  // runner and wipe the KV cache between turns
  num_ctx?: number
  // cap generated tokens, including thinking, through options.num_predict
  num_predict?: number
}

export interface ChatResponse
{
  message: OllamaMessage
  done: boolean
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

export interface EmbedResponse
{
  embeddings: number[][]
}

export interface Model
{
  name: string
  model?: string
  size: number
  modified_at: string
  digest?: string
}

export interface ModelInfo
{
  // native max context (max position embeddings) reported by the model
  contextLength: number
  // architecture id from general.architecture (e.g. 'gemma4', 'mistral3')
  architecture?: string
  // transformer block count
  blockCount?: number
  // KV head count (GQA), absent for some architectures in Ollama metadata
  kvHeadCount?: number
  // per-head key and value dimensions
  keyLength?: number
  valueLength?: number
}

// reliability counters for model tool-call recovery, surfaced in /status,
// /telemetry, and evaluation reports
export interface ReliabilityStats
{
  repairedToolCalls: number
  nameRepairs: number
  stallNudges: number
  validationFailures: number
  // edits that landed via the whitespace-tolerant fallback
  editRepairs: number
  // times the agent paused on a detected doom loop
  doomLoopTrips: number
  // corrective reprompts when a call-shaped turn wouldn't parse
  reprompts: number
  // edits a self-check flagged as wrong or inconclusive
  verifyFlags: number
  // failed self-checks fed back to the model for a fix attempt
  verifyReprompts: number
}

export function makeReliabilityStats(
  overrides: Partial<ReliabilityStats> = {}
): ReliabilityStats
{
  return {
    repairedToolCalls: 0,
    nameRepairs: 0,
    stallNudges: 0,
    validationFailures: 0,
    editRepairs: 0,
    doomLoopTrips: 0,
    reprompts: 0,
    verifyFlags: 0,
    verifyReprompts: 0,
    ...overrides,
  }
}
