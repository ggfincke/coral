// src/protocol/generated/validators.ts
// generated Ajv validators with embedded protocol JSON schemas

import addFormatsModule from 'ajv-formats'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type {
  CoralExecFrame,
  Envelope,
  HandshakeFrame,
  ChatProtocol,
  ModelProtocol,
  EmbeddingProtocol,
} from './types.js'

const addFormats =
  addFormatsModule as unknown as typeof addFormatsModule.default

const ajv = addFormats(
  new Ajv2020({
    strict: false,
    strictNumbers: true,
    allErrors: true,
    discriminator: true,
  })
)

export interface ProtocolValidation
{
  valid: boolean
  errors?: string
}

function compileSchema(
  schema: Record<string, unknown>
): (value: unknown) => ProtocolValidation
{
  const validate = ajv.compile(schema)
  return (value) =>
  {
    if (validate(value)) return { valid: true }
    return { valid: false, errors: ajv.errorsText(validate.errors) }
  }
}

const schema0 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/ggfincke/coral/protocol/exec-events.schema.json',
  title: 'CoralExecFrame',
  $comment:
    'Sibling of the worker envelope: coral exec JSONL events plus the bare CoralExecResult object. Stream usage is camelCase TokenUsage; result.usage is snake_case four fields.',
  oneOf: [
    { $ref: '#/$defs/CoralExecEvent' },
    { $ref: '#/$defs/CoralExecResult' },
  ],
  $defs: {
    TokenUsage: {
      title: 'TokenUsage',
      type: 'object',
      additionalProperties: false,
      required: [
        'promptTokens',
        'completionTokens',
        'totalPromptTokens',
        'totalCompletionTokens',
        'contextTokens',
        'totalPromptEvalDurationNs',
        'totalEvalDurationNs',
      ],
      properties: {
        promptTokens: { type: 'number' },
        completionTokens: { type: 'number' },
        totalPromptTokens: { type: 'number' },
        totalCompletionTokens: { type: 'number' },
        contextTokens: { type: 'number' },
        promptEvalDurationNs: { type: 'number' },
        evalDurationNs: { type: 'number' },
        totalPromptEvalDurationNs: { type: 'number' },
        totalEvalDurationNs: { type: 'number' },
      },
    },
    CoralExecResultUsage: {
      title: 'CoralExecResultUsage',
      type: 'object',
      additionalProperties: false,
      required: [
        'prompt_tokens',
        'completion_tokens',
        'prompt_eval_duration_ns',
        'eval_duration_ns',
      ],
      properties: {
        prompt_tokens: { type: 'number' },
        completion_tokens: { type: 'number' },
        prompt_eval_duration_ns: { type: 'number' },
        eval_duration_ns: { type: 'number' },
      },
    },
    JsonObject: {
      title: 'JsonObject',
      type: 'object',
      additionalProperties: true,
    },
    CoralExecResult: {
      title: 'CoralExecResult',
      type: 'object',
      additionalProperties: false,
      required: ['version', 'run_id', 'status', 'model', 'response', 'usage'],
      properties: {
        version: { const: 1 },
        run_id: { type: 'string', minLength: 1 },
        status: { enum: ['completed', 'failed', 'cancelled'] },
        model: { type: 'string' },
        response: { type: 'string' },
        usage: { $ref: '#/$defs/CoralExecResultUsage' },
        error: { type: 'string' },
      },
    },
    InitEvent: {
      title: 'InitEvent',
      type: 'object',
      additionalProperties: true,
      required: ['type', 'run_id', 'model'],
      properties: {
        type: { const: 'init' },
        run_id: { type: 'string', minLength: 1 },
        model: { type: 'string' },
      },
    },
    AssistantDeltaEvent: {
      title: 'AssistantDeltaEvent',
      type: 'object',
      additionalProperties: true,
      required: ['type', 'text', 'run_id'],
      properties: {
        type: { const: 'assistant_delta' },
        text: { type: 'string' },
        run_id: { type: 'string', minLength: 1 },
      },
    },
    ThinkingDeltaEvent: {
      title: 'ThinkingDeltaEvent',
      type: 'object',
      additionalProperties: true,
      required: ['type', 'text', 'run_id'],
      properties: {
        type: { const: 'thinking_delta' },
        text: { type: 'string' },
        run_id: { type: 'string', minLength: 1 },
      },
    },
    ToolCallEvent: {
      title: 'ToolCallEvent',
      type: 'object',
      additionalProperties: true,
      required: ['type', 'name', 'args', 'call_id', 'run_id'],
      properties: {
        type: { const: 'tool_call' },
        name: { type: 'string' },
        args: { $ref: '#/$defs/JsonObject' },
        call_id: { type: 'number' },
        run_id: { type: 'string', minLength: 1 },
      },
    },
    ToolResultEvent: {
      title: 'ToolResultEvent',
      type: 'object',
      additionalProperties: true,
      required: ['type', 'name', 'output', 'call_id', 'run_id'],
      properties: {
        type: { const: 'tool_result' },
        name: { type: 'string' },
        output: { type: 'string' },
        error: { type: 'string' },
        call_id: { type: 'number' },
        diff: { type: 'string' },
        run_id: { type: 'string', minLength: 1 },
      },
    },
    ApprovalRejectedEvent: {
      title: 'ApprovalRejectedEvent',
      type: 'object',
      additionalProperties: true,
      required: ['type', 'name', 'args', 'run_id'],
      properties: {
        type: { const: 'approval_rejected' },
        name: { type: 'string' },
        args: { $ref: '#/$defs/JsonObject' },
        run_id: { type: 'string', minLength: 1 },
      },
    },
    McpLaunchRejectedEvent: {
      title: 'McpLaunchRejectedEvent',
      type: 'object',
      additionalProperties: true,
      required: ['type', 'alias', 'run_id'],
      properties: {
        type: { const: 'mcp_launch_rejected' },
        alias: { type: 'string' },
        run_id: { type: 'string', minLength: 1 },
      },
    },
    DoomLoopStoppedEvent: {
      title: 'DoomLoopStoppedEvent',
      type: 'object',
      additionalProperties: true,
      required: ['type', 'message', 'run_id'],
      properties: {
        type: { const: 'doom_loop_stopped' },
        message: { type: 'string' },
        run_id: { type: 'string', minLength: 1 },
      },
    },
    UsageEvent: {
      title: 'UsageEvent',
      type: 'object',
      additionalProperties: true,
      required: ['type', 'usage', 'run_id'],
      properties: {
        type: { const: 'usage' },
        usage: { $ref: '#/$defs/TokenUsage' },
        run_id: { type: 'string', minLength: 1 },
      },
    },
    DoneEvent: {
      title: 'DoneEvent',
      type: 'object',
      additionalProperties: true,
      required: ['type', 'run_id'],
      properties: {
        type: { const: 'done' },
        run_id: { type: 'string', minLength: 1 },
      },
    },
    ErrorEvent: {
      title: 'ErrorEvent',
      type: 'object',
      additionalProperties: true,
      required: ['type', 'error', 'run_id'],
      properties: {
        type: { const: 'error' },
        error: { type: 'string' },
        run_id: { type: 'string', minLength: 1 },
      },
    },
    ResultEvent: {
      title: 'ResultEvent',
      type: 'object',
      additionalProperties: false,
      required: [
        'type',
        'version',
        'run_id',
        'status',
        'model',
        'response',
        'usage',
      ],
      properties: {
        type: { const: 'result' },
        version: { const: 1 },
        run_id: { type: 'string', minLength: 1 },
        status: { enum: ['completed', 'failed', 'cancelled'] },
        model: { type: 'string' },
        response: { type: 'string' },
        usage: { $ref: '#/$defs/CoralExecResultUsage' },
        error: { type: 'string' },
      },
    },
    CoralExecEvent: {
      title: 'CoralExecEvent',
      discriminator: { propertyName: 'type' },
      oneOf: [
        { $ref: '#/$defs/InitEvent' },
        { $ref: '#/$defs/AssistantDeltaEvent' },
        { $ref: '#/$defs/ThinkingDeltaEvent' },
        { $ref: '#/$defs/ToolCallEvent' },
        { $ref: '#/$defs/ToolResultEvent' },
        { $ref: '#/$defs/ApprovalRejectedEvent' },
        { $ref: '#/$defs/McpLaunchRejectedEvent' },
        { $ref: '#/$defs/DoomLoopStoppedEvent' },
        { $ref: '#/$defs/UsageEvent' },
        { $ref: '#/$defs/DoneEvent' },
        { $ref: '#/$defs/ErrorEvent' },
        { $ref: '#/$defs/ResultEvent' },
      ],
    },
  },
} as Record<string, unknown>
const schema1 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/ggfincke/coral/protocol/envelope.schema.json',
  title: 'Envelope',
  $comment:
    'Every worker-stdio frame (Phase 2+) is one NDJSON envelope. coral exec JSONL is a sibling schema and is not wrapped in this envelope.',
  discriminator: { propertyName: 'kind' },
  oneOf: [
    { $ref: '#/$defs/EnvelopeRequest' },
    { $ref: '#/$defs/EnvelopeEvent' },
    { $ref: '#/$defs/EnvelopeResult' },
    { $ref: '#/$defs/EnvelopeCancel' },
    { $ref: '#/$defs/EnvelopeError' },
  ],
  $defs: {
    EnvelopePayload: {
      title: 'EnvelopePayload',
      type: 'object',
      additionalProperties: true,
    },
    EnvelopeErrorPayload: {
      title: 'EnvelopeErrorPayload',
      $comment:
        'kind:error payload is pinned to message; optional code names the worker failure class. Do not send a sibling error string.',
      type: 'object',
      additionalProperties: true,
      required: ['message'],
      properties: {
        message: { type: 'string', minLength: 1 },
        code: { type: 'string', minLength: 1 },
      },
    },
    EnvelopeRequest: {
      title: 'EnvelopeRequest',
      type: 'object',
      additionalProperties: true,
      required: ['v', 'id', 'kind', 'method', 'payload'],
      properties: {
        v: { const: 1 },
        id: { type: 'string', minLength: 1 },
        kind: { const: 'request' },
        method: { type: 'string', minLength: 1 },
        payload: { $ref: '#/$defs/EnvelopePayload' },
      },
    },
    EnvelopeEvent: {
      title: 'EnvelopeEvent',
      type: 'object',
      additionalProperties: true,
      required: ['v', 'id', 'kind', 'method', 'payload'],
      properties: {
        v: { const: 1 },
        id: { type: 'string', minLength: 1 },
        kind: { const: 'event' },
        method: { type: 'string', minLength: 1 },
        payload: { $ref: '#/$defs/EnvelopePayload' },
      },
    },
    EnvelopeResult: {
      title: 'EnvelopeResult',
      type: 'object',
      additionalProperties: true,
      required: ['v', 'id', 'kind', 'method', 'payload'],
      properties: {
        v: { const: 1 },
        id: { type: 'string', minLength: 1 },
        kind: { const: 'result' },
        method: { type: 'string', minLength: 1 },
        payload: { $ref: '#/$defs/EnvelopePayload' },
      },
    },
    EnvelopeCancel: {
      title: 'EnvelopeCancel',
      type: 'object',
      additionalProperties: true,
      required: ['v', 'id', 'kind'],
      properties: {
        v: { const: 1 },
        id: { type: 'string', minLength: 1 },
        kind: { const: 'cancel' },
      },
    },
    EnvelopeError: {
      title: 'EnvelopeError',
      type: 'object',
      additionalProperties: true,
      required: ['v', 'id', 'kind', 'payload'],
      properties: {
        v: { const: 1 },
        id: { type: 'string', minLength: 1 },
        kind: { const: 'error' },
        method: { type: 'string', minLength: 1 },
        payload: { $ref: '#/$defs/EnvelopeErrorPayload' },
      },
    },
  },
} as Record<string, unknown>
const schema2 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/ggfincke/coral/protocol/handshake.schema.json',
  title: 'HandshakeFrame',
  $comment:
    'First worker request after spawn. Payloads ride inside the envelope (method handshake). Phase 3 workers advertise embed alongside chat.start, model.list, and model.show. TS refuses methods the worker did not advertise.',
  oneOf: [
    { $ref: '#/$defs/HandshakeRequest' },
    { $ref: '#/$defs/HandshakeResult' },
  ],
  $defs: {
    HandshakeRequest: {
      title: 'HandshakeRequest',
      type: 'object',
      additionalProperties: true,
      required: ['protocolVersion', 'client'],
      properties: {
        protocolVersion: { const: 1 },
        client: { type: 'string', minLength: 1 },
        modelsDir: { type: 'string', minLength: 1 },
      },
    },
    HandshakeVersions: {
      title: 'HandshakeVersions',
      type: 'object',
      additionalProperties: true,
      required: ['python'],
      properties: {
        python: { type: 'string', minLength: 1 },
        mlx: { type: 'string' },
        mlx_lm: { type: 'string' },
      },
    },
    HandshakeResult: {
      title: 'HandshakeResult',
      type: 'object',
      additionalProperties: true,
      required: ['protocolVersion', 'methods', 'versions'],
      properties: {
        protocolVersion: { type: 'integer', minimum: 1 },
        methods: { type: 'array', items: { type: 'string', minLength: 1 } },
        versions: { $ref: '#/$defs/HandshakeVersions' },
      },
    },
  },
} as Record<string, unknown>
const schema3 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/ggfincke/coral/protocol/chat.schema.json',
  title: 'ChatProtocol',
  $comment:
    'Ollama-dialect ChatRequest / ChatResponse from src/types/inference.ts. Durations are nanoseconds. tool_calls.function.arguments is an object. Streaming partial tool calls must set function.index.',
  oneOf: [{ $ref: '#/$defs/ChatRequest' }, { $ref: '#/$defs/ChatResponse' }],
  $defs: {
    ChatJsonObject: {
      title: 'ChatJsonObject',
      type: 'object',
      additionalProperties: true,
    },
    JsonSchema: {
      title: 'JsonSchema',
      type: 'object',
      additionalProperties: true,
      required: ['type'],
      properties: { type: { const: 'object' } },
    },
    OllamaToolCallFunction: {
      title: 'OllamaToolCallFunction',
      type: 'object',
      additionalProperties: true,
      required: ['name', 'arguments'],
      properties: {
        index: { type: 'integer' },
        name: { type: 'string' },
        arguments: { $ref: '#/$defs/ChatJsonObject' },
      },
    },
    OllamaToolCall: {
      title: 'OllamaToolCall',
      type: 'object',
      additionalProperties: true,
      required: ['function'],
      properties: {
        type: { const: 'function' },
        function: { $ref: '#/$defs/OllamaToolCallFunction' },
      },
    },
    OllamaToolFunction: {
      title: 'OllamaToolFunction',
      type: 'object',
      additionalProperties: true,
      required: ['name', 'description', 'parameters'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        parameters: { $ref: '#/$defs/JsonSchema' },
      },
    },
    OllamaTool: {
      title: 'OllamaTool',
      type: 'object',
      additionalProperties: true,
      required: ['type', 'function'],
      properties: {
        type: { const: 'function' },
        function: { $ref: '#/$defs/OllamaToolFunction' },
      },
    },
    AttachmentReportAttached: {
      title: 'AttachmentReportAttached',
      type: 'object',
      additionalProperties: false,
      required: ['path', 'truncated'],
      properties: { path: { type: 'string' }, truncated: { type: 'boolean' } },
    },
    AttachmentReportSkip: {
      title: 'AttachmentReportSkip',
      type: 'object',
      additionalProperties: false,
      required: ['path', 'reason'],
      properties: {
        path: { type: 'string' },
        reason: {
          enum: [
            'not found',
            'too large',
            'binary',
            'unreadable',
            'outside workspace',
            'over budget',
          ],
        },
      },
    },
    AttachmentReport: {
      title: 'AttachmentReport',
      type: 'object',
      additionalProperties: true,
      required: ['attached', 'skipped'],
      properties: {
        attached: {
          type: 'array',
          items: { $ref: '#/$defs/AttachmentReportAttached' },
        },
        skipped: {
          type: 'array',
          items: { $ref: '#/$defs/AttachmentReportSkip' },
        },
        omittedOverBudget: { type: 'number' },
      },
    },
    ModelRequestMessage: {
      title: 'ModelRequestMessage',
      type: 'object',
      additionalProperties: true,
      required: ['role', 'content'],
      properties: {
        role: { enum: ['system', 'user', 'assistant', 'tool'] },
        content: { type: 'string' },
        thinking: { type: 'string' },
        tool_name: { type: 'string' },
        tool_calls: {
          type: 'array',
          items: { $ref: '#/$defs/OllamaToolCall' },
        },
      },
    },
    OllamaMessage: {
      title: 'OllamaMessage',
      type: 'object',
      additionalProperties: true,
      required: ['role', 'content'],
      properties: {
        role: { enum: ['system', 'user', 'assistant', 'tool'] },
        content: { type: 'string' },
        thinking: { type: 'string' },
        tool_name: { type: 'string' },
        tool_calls: {
          type: 'array',
          items: { $ref: '#/$defs/OllamaToolCall' },
        },
        displayContent: { type: 'string' },
        attachmentReport: { $ref: '#/$defs/AttachmentReport' },
      },
    },
    ChatThink: {
      title: 'ChatThink',
      anyOf: [{ type: 'boolean' }, { enum: ['low', 'medium', 'high'] }],
    },
    ChatKeepAlive: {
      title: 'ChatKeepAlive',
      anyOf: [{ type: 'string' }, { type: 'number' }],
    },
    ChatRequest: {
      title: 'ChatRequest',
      type: 'object',
      additionalProperties: true,
      required: ['model', 'messages'],
      properties: {
        model: { type: 'string' },
        messages: {
          type: 'array',
          items: { $ref: '#/$defs/ModelRequestMessage' },
        },
        tools: { type: 'array', items: { $ref: '#/$defs/OllamaTool' } },
        think: { $ref: '#/$defs/ChatThink' },
        keep_alive: { $ref: '#/$defs/ChatKeepAlive' },
        num_ctx: { type: 'number' },
        num_predict: { type: 'number' },
      },
    },
    ChatResponse: {
      title: 'ChatResponse',
      type: 'object',
      additionalProperties: true,
      required: ['message', 'done'],
      properties: {
        message: { $ref: '#/$defs/OllamaMessage' },
        done: { type: 'boolean' },
        prompt_eval_count: { type: 'number' },
        prompt_eval_duration: { type: 'number' },
        eval_count: { type: 'number' },
        eval_duration: { type: 'number' },
      },
    },
  },
} as Record<string, unknown>
const schema4 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/ggfincke/coral/protocol/model.schema.json',
  title: 'ModelProtocol',
  $comment:
    'Mirrors Model, ModelInfo in src/types/inference.ts plus ModelRef and the pinned model.list / model.show request and result wrappers. Closed backend set: ollama | mlx. model.show uses payload.name (checkpoint remainder, not mlx:). model.list result is { models: Model[] }. ModelInfo.size is weight bytes.',
  oneOf: [
    { $ref: '#/$defs/Model' },
    { $ref: '#/$defs/ModelInfo' },
    { $ref: '#/$defs/ModelRef' },
    { $ref: '#/$defs/ModelListRequest' },
    { $ref: '#/$defs/ModelShowRequest' },
    { $ref: '#/$defs/ModelListResult' },
  ],
  $defs: {
    Model: {
      title: 'Model',
      type: 'object',
      additionalProperties: true,
      required: ['name', 'size', 'modified_at'],
      properties: {
        name: { type: 'string' },
        model: { type: 'string' },
        size: { type: 'number' },
        modified_at: { type: 'string' },
        digest: { type: 'string' },
      },
    },
    ModelInfo: {
      title: 'ModelInfo',
      type: 'object',
      additionalProperties: true,
      required: ['contextLength'],
      properties: {
        contextLength: { type: 'number' },
        architecture: { type: 'string' },
        blockCount: { type: 'number' },
        kvHeadCount: { type: 'number' },
        keyLength: { type: 'number' },
        valueLength: { type: 'number' },
        size: {
          type: 'number',
          $comment:
            'weight bytes for this checkpoint; same units as Model.size',
        },
        digest: {
          type: 'string',
          $comment:
            '64-hex SHA-256 artifact digest (coral/mlx-artifact/v1) so TS can assert identity before/after embed',
        },
      },
    },
    ModelListRequest: {
      title: 'ModelListRequest',
      $comment:
        'model.list request. Empty object is valid. Optional modelsDir overrides inventory for that call only; spawn-time CORAL_MLX_MODELS_DIR still wins in the worker.',
      type: 'object',
      additionalProperties: false,
      properties: { modelsDir: { type: 'string', minLength: 1 } },
    },
    ModelShowRequest: {
      title: 'ModelShowRequest',
      $comment:
        'model.show request. name is the checkpoint remainder (not the mlx: canonical ref).',
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string', minLength: 1 } },
    },
    ModelListResult: {
      title: 'ModelListResult',
      type: 'object',
      additionalProperties: false,
      required: ['models'],
      properties: {
        models: { type: 'array', items: { $ref: '#/$defs/Model' } },
      },
    },
    ModelRef: {
      title: 'ModelRef',
      type: 'object',
      additionalProperties: false,
      required: ['backend', 'model', 'canonical'],
      properties: {
        backend: { enum: ['ollama', 'mlx'] },
        model: { type: 'string', minLength: 1 },
        canonical: { type: 'string', minLength: 1 },
      },
    },
  },
} as Record<string, unknown>
const schema5 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/ggfincke/coral/protocol/embedding.schema.json',
  title: 'EmbeddingProtocol',
  $comment:
    'Worker embed method. JSON float arrays only (no packed encodings). model is the checkpoint remainder, matching model.show name. Empty texts yield empty vectors.',
  oneOf: [{ $ref: '#/$defs/EmbedRequest' }, { $ref: '#/$defs/EmbedResult' }],
  $defs: {
    EmbedRequest: {
      title: 'EmbedRequest',
      type: 'object',
      additionalProperties: false,
      required: ['model', 'texts'],
      properties: {
        model: { type: 'string', minLength: 1 },
        texts: { type: 'array', items: { type: 'string' } },
      },
    },
    EmbedResult: {
      title: 'EmbedResult',
      type: 'object',
      additionalProperties: false,
      required: ['vectors'],
      properties: {
        vectors: {
          type: 'array',
          items: { type: 'array', items: { type: 'number' } },
        },
      },
    },
  },
} as Record<string, unknown>

export const validateCoralExecFrame = compileSchema(schema0)

export function isCoralExecFrame(value: unknown): value is CoralExecFrame
{
  return validateCoralExecFrame(value).valid
}

export const validateEnvelope = compileSchema(schema1)

export function isEnvelope(value: unknown): value is Envelope
{
  return validateEnvelope(value).valid
}

export const validateHandshakeFrame = compileSchema(schema2)

export function isHandshakeFrame(value: unknown): value is HandshakeFrame
{
  return validateHandshakeFrame(value).valid
}

export const validateChatProtocol = compileSchema(schema3)

export function isChatProtocol(value: unknown): value is ChatProtocol
{
  return validateChatProtocol(value).valid
}

export const validateModelProtocol = compileSchema(schema4)

export function isModelProtocol(value: unknown): value is ModelProtocol
{
  return validateModelProtocol(value).valid
}

export const validateEmbeddingProtocol = compileSchema(schema5)

export function isEmbeddingProtocol(
  value: unknown
): value is EmbeddingProtocol
{
  return validateEmbeddingProtocol(value).valid
}
