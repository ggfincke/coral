// src/agent/request/projection.ts
// model-request projection and token estimation

import type {
  ModelRequestMessage,
  OllamaMessage,
  OllamaTool,
  OllamaToolCall,
} from '../../types/inference.js'
import {
  CHARS_PER_TOKEN,
  estimateModelRequestValue,
  estimateUtf8Tokens,
} from '../../utils/limits.js'

// estimate each allowlisted message and tool definition as its own frame
const MODEL_REQUEST_FRAME = '{"messages":[],"tools":}'
const MODEL_REQUEST_FRAME_UTF8_BYTES =
  estimateUtf8Tokens(MODEL_REQUEST_FRAME).utf8Bytes

function nonNegativeInteger(value: number, label: string): number
{
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value))
  {
    throw new RangeError(`${label} must be a non-negative integer`)
  }
  return value
}

// project only request fields so UI and persistence fields stay out of accounting
export function toModelRequestMessage(
  message: OllamaMessage | ModelRequestMessage
): ModelRequestMessage
{
  const projected: ModelRequestMessage = {
    role: message.role,
    content: message.content,
  }

  if (message.thinking !== undefined) projected.thinking = message.thinking
  if (message.tool_name !== undefined) projected.tool_name = message.tool_name
  if (message.tool_calls !== undefined)
  {
    projected.tool_calls = message.tool_calls.map(projectToolCall)
  }

  return projected
}

function projectToolCall(call: OllamaToolCall): OllamaToolCall
{
  const projected: OllamaToolCall = {
    function: {
      name: call.function.name,
      arguments: { ...call.function.arguments },
    },
  }

  if (call.type !== undefined) projected.type = call.type
  if (call.function.index !== undefined)
  {
    projected.function.index = call.function.index
  }
  return projected
}

function projectToolDefinition(tool: OllamaTool): OllamaTool
{
  return {
    type: 'function',
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }
}

export function estimateModelRequestMessageTokens(
  message: OllamaMessage | ModelRequestMessage
): number
{
  return estimateModelRequestValue(toModelRequestMessage(message)).tokens
}

export function estimateModelRequestMessagesTokens(
  messages: readonly (OllamaMessage | ModelRequestMessage)[]
): number
{
  return messages.reduce(
    (total, message) => total + estimateModelRequestMessageTokens(message),
    0
  )
}

export function estimateModelRequestMessageDeltaTokens(
  base: OllamaMessage | ModelRequestMessage,
  expanded: OllamaMessage | ModelRequestMessage
): number
{
  return Math.max(
    estimateModelRequestMessageTokens(expanded) -
      estimateModelRequestMessageTokens(base),
    0
  )
}

export function estimateModelRequestToolTokens(
  tools: readonly OllamaTool[]
): number
{
  return estimateModelRequestValue(tools.map(projectToolDefinition)).tokens
}

export function estimateRequestFramingTokens(messageCount: number): number
{
  const count = nonNegativeInteger(messageCount, 'messageCount')
  const separatorBytes = Math.max(count - 1, 0)
  return Math.ceil(
    (MODEL_REQUEST_FRAME_UTF8_BYTES + separatorBytes) / CHARS_PER_TOKEN
  )
}
