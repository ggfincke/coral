// src/types/inference.ts
// shared inference message, tool, & model metadata types

export interface JsonSchema
{
  type: 'object'
  properties: Record<
    string,
    {
      type: string
      description?: string
      enum?: string[]
      // element schema for array-typed properties
      items?: { type: string }
    }
  >
  required?: string[]
}

export interface OllamaMessage
{
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  tool_name?: string
  tool_calls?: OllamaToolCall[]
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
  messages: OllamaMessage[]
  stream?: boolean
  tools?: OllamaTool[]
  think?: boolean | 'low' | 'medium' | 'high'
  keep_alive?: string | number
  // ! constrains content only & silently empties tool_calls when combined
  // ! w/ tools (ollama#8095) — never set on tool-bearing requests
  format?: 'json' | Record<string, unknown>
}

export interface ChatResponse
{
  message: OllamaMessage
  done: boolean
  done_reason?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

export interface Model
{
  name: string
  size: number
  modified_at: string
}

export interface ModelInfo
{
  context_length: number
}
