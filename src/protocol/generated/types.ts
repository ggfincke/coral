// src/protocol/generated/types.ts
// generated TypeScript types from protocol/ JSON schemas

export type CoralExecFrame = CoralExecEvent | CoralExecResult
export type CoralExecEvent =
  | InitEvent
  | AssistantDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalRejectedEvent
  | McpLaunchRejectedEvent
  | DoomLoopStoppedEvent
  | UsageEvent
  | DoneEvent
  | ErrorEvent
  | ResultEvent

export interface InitEvent
{
  type: 'init'
  run_id: string
  model: string
  [k: string]: unknown
}
export interface AssistantDeltaEvent
{
  type: 'assistant_delta'
  text: string
  run_id: string
  [k: string]: unknown
}
export interface ThinkingDeltaEvent
{
  type: 'thinking_delta'
  text: string
  run_id: string
  [k: string]: unknown
}
export interface ToolCallEvent
{
  type: 'tool_call'
  name: string
  args: JsonObject
  call_id: number
  run_id: string
  [k: string]: unknown
}
export interface JsonObject
{
  [k: string]: unknown
}
export interface ToolResultEvent
{
  type: 'tool_result'
  name: string
  output: string
  error?: string
  call_id: number
  diff?: string
  run_id: string
  [k: string]: unknown
}
export interface ApprovalRejectedEvent
{
  type: 'approval_rejected'
  name: string
  args: JsonObject
  run_id: string
  [k: string]: unknown
}
export interface McpLaunchRejectedEvent
{
  type: 'mcp_launch_rejected'
  alias: string
  run_id: string
  [k: string]: unknown
}
export interface DoomLoopStoppedEvent
{
  type: 'doom_loop_stopped'
  message: string
  run_id: string
  [k: string]: unknown
}
export interface UsageEvent
{
  type: 'usage'
  usage: TokenUsage
  run_id: string
  [k: string]: unknown
}
export interface TokenUsage
{
  promptTokens: number
  completionTokens: number
  totalPromptTokens: number
  totalCompletionTokens: number
  contextTokens: number
  promptEvalDurationNs?: number
  evalDurationNs?: number
  totalPromptEvalDurationNs: number
  totalEvalDurationNs: number
}
export interface DoneEvent
{
  type: 'done'
  run_id: string
  [k: string]: unknown
}
export interface ErrorEvent
{
  type: 'error'
  error: string
  run_id: string
  [k: string]: unknown
}
export interface ResultEvent
{
  type: 'result'
  version: 1
  run_id: string
  status: 'completed' | 'failed' | 'cancelled'
  model: string
  response: string
  usage: CoralExecResultUsage
  error?: string
}
export interface CoralExecResultUsage
{
  prompt_tokens: number
  completion_tokens: number
  prompt_eval_duration_ns: number
  eval_duration_ns: number
}
export interface CoralExecResult
{
  version: 1
  run_id: string
  status: 'completed' | 'failed' | 'cancelled'
  model: string
  response: string
  usage: CoralExecResultUsage
  error?: string
}

export type Envelope =
  | EnvelopeRequest
  | EnvelopeEvent
  | EnvelopeResult
  | EnvelopeCancel
  | EnvelopeError

export interface EnvelopeRequest
{
  v: 1
  id: string
  kind: 'request'
  method: string
  payload: EnvelopePayload
  [k: string]: unknown
}
export interface EnvelopePayload
{
  [k: string]: unknown
}
export interface EnvelopeEvent
{
  v: 1
  id: string
  kind: 'event'
  method: string
  payload: EnvelopePayload
  [k: string]: unknown
}
export interface EnvelopeResult
{
  v: 1
  id: string
  kind: 'result'
  method: string
  payload: EnvelopePayload
  [k: string]: unknown
}
export interface EnvelopeCancel
{
  v: 1
  id: string
  kind: 'cancel'
  [k: string]: unknown
}
export interface EnvelopeError
{
  v: 1
  id: string
  kind: 'error'
  method?: string
  payload: EnvelopeErrorPayload
  [k: string]: unknown
}
export interface EnvelopeErrorPayload
{
  message: string
  code?: string
  [k: string]: unknown
}

export type HandshakeFrame = HandshakeRequest | HandshakeResult

export interface HandshakeRequest
{
  protocolVersion: 1
  client: string
  modelsDir?: string
  [k: string]: unknown
}
export interface HandshakeResult
{
  protocolVersion: number
  methods: string[]
  versions: HandshakeVersions
  [k: string]: unknown
}
export interface HandshakeVersions
{
  python: string
  mlx?: string
  mlx_lm?: string
  [k: string]: unknown
}

export type ChatProtocol = ChatRequest | ChatResponse
export type ChatThink = boolean | ('low' | 'medium' | 'high')
export type ChatKeepAlive = string | number

export interface ChatRequest
{
  model: string
  messages: ModelRequestMessage[]
  tools?: OllamaTool[]
  think?: ChatThink
  keep_alive?: ChatKeepAlive
  num_ctx?: number
  num_predict?: number
  [k: string]: unknown
}
export interface ModelRequestMessage
{
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  tool_name?: string
  tool_calls?: OllamaToolCall[]
  [k: string]: unknown
}
export interface OllamaToolCall
{
  type?: 'function'
  function: OllamaToolCallFunction
  [k: string]: unknown
}
export interface OllamaToolCallFunction
{
  index?: number
  name: string
  arguments: ChatJsonObject
  [k: string]: unknown
}
export interface ChatJsonObject
{
  [k: string]: unknown
}
export interface OllamaTool
{
  type: 'function'
  function: OllamaToolFunction
  [k: string]: unknown
}
export interface OllamaToolFunction
{
  name: string
  description: string
  parameters: JsonSchema
  [k: string]: unknown
}
export interface JsonSchema
{
  type: 'object'
  [k: string]: unknown
}
export interface ChatResponse
{
  message: OllamaMessage
  done: boolean
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
  [k: string]: unknown
}
export interface OllamaMessage
{
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  tool_name?: string
  tool_calls?: OllamaToolCall[]
  displayContent?: string
  attachmentReport?: AttachmentReport
  [k: string]: unknown
}
export interface AttachmentReport
{
  attached: AttachmentReportAttached[]
  skipped: AttachmentReportSkip[]
  omittedOverBudget?: number
  [k: string]: unknown
}
export interface AttachmentReportAttached
{
  path: string
  truncated: boolean
}
export interface AttachmentReportSkip
{
  path: string
  reason:
    | 'not found'
    | 'too large'
    | 'binary'
    | 'unreadable'
    | 'outside workspace'
    | 'over budget'
}

export type ModelProtocol =
  | Model
  | ModelInfo
  | ModelRef
  | ModelListRequest
  | ModelShowRequest
  | ModelListResult

export interface Model
{
  name: string
  model?: string
  size: number
  modified_at: string
  digest?: string
  [k: string]: unknown
}
export interface ModelInfo
{
  contextLength: number
  architecture?: string
  blockCount?: number
  kvHeadCount?: number
  keyLength?: number
  valueLength?: number
  size?: number
  digest?: string
  [k: string]: unknown
}
export interface ModelRef
{
  backend: 'ollama' | 'mlx'
  model: string
  canonical: string
}
export interface ModelListRequest
{
  modelsDir?: string
}
export interface ModelShowRequest
{
  name: string
}
export interface ModelListResult
{
  models: Model[]
}

export type EmbeddingProtocol = EmbedRequest | EmbedResult

export interface EmbedRequest
{
  model: string
  texts: string[]
}
export interface EmbedResult
{
  vectors: number[][]
}
