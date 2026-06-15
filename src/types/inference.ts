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
  tools?: OllamaTool[]
  think?: boolean | 'low' | 'medium' | 'high'
  keep_alive?: string | number
  // pinned context window — sent as options.num_ctx; held constant per session
  // so Ollama doesn't reload the runner & wipe the KV cache between turns
  num_ctx?: number
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
  size: number
  modified_at: string
}

export interface ModelInfo
{
  // native max context (max position embeddings) reported by the model
  contextLength: number
  // architecture id from general.architecture (e.g. 'gemma4', 'mistral3')
  architecture?: string
  // transformer block count
  blockCount?: number
  // KV head count (GQA) — absent for some archs (e.g. gemma) in Ollama metadata
  kvHeadCount?: number
  // per-head key & value dims
  keyLength?: number
  valueLength?: number
}
