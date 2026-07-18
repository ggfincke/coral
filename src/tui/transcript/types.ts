// src/tui/transcript/types.ts
// neutral transcript output block contracts

import type { ToolCallPresentation } from '../../tools/tool.js'

export interface UserBlock
{
  type: 'user'
  content: string
}

export interface AssistantBlock
{
  type: 'assistant'
  content: string
}

export interface ThinkingBlock
{
  type: 'thinking'
  content: string
}

// emitted when a tool call starts
export interface ToolCallBlock
{
  type: 'tool_call'
  toolName: string
  args: Record<string, unknown>
  // correlate parallel results to their originating calls
  callId?: number
  status?: 'success' | 'error'
  duration?: number
  // preserve the event-time display snapshot across catalog refreshes
  display?: ToolCallPresentation
}

export interface ToolResultBlock
{
  type: 'tool_result'
  toolName: string
  content: string
  isError?: boolean
}

export interface DiffBlock
{
  type: 'diff'
  unified: string
}

export interface ErrorBlock
{
  type: 'error'
  content: string
}

export interface SystemBlock
{
  type: 'system'
  content: string
}

export type OutputBlock =
  | UserBlock
  | AssistantBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | DiffBlock
  | ErrorBlock
  | SystemBlock
