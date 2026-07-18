// src/tools/tool.ts
// tool interface and conversion to Ollama format

import type { OllamaTool, JsonSchema } from '../types/inference.js'
import { estimateModelRequestValue } from '../utils/limits.js'
import type { SubagentRunner } from './subagent.js'
import type { UndoFileChange, UndoTodoChange } from '../types/undo.js'
import type { CodeIntelService } from '../lsp/contracts.js'
import type { TodoState } from '../types/todo.js'

// result returned after tool execution
export interface ToolResult
{
  output: string
  error?: string
  // unified diff of a file change — TUI display only, never sent to the model
  diff?: string
  // reversible file mutation used by /undo; omitted when previous state is
  // unavailable or the tool did not change a file
  change?: UndoFileChange
  // reversible local-state mutation used by /undo for non-file Coral state
  todoChange?: UndoTodoChange
  // tool recovered from a near-miss call (e.g. a whitespace-tolerant edit match);
  // the agent folds this into ReliabilityStats
  repaired?: boolean
}

// TUI presentation metadata — one source of truth for the tool header, label,
// and argument summary
export interface ToolDisplay
{
  label: string
  summarize?(args: Record<string, unknown>): string
}

// immutable presentation snapshot taken at call emission so historical blocks
// never consult a refreshed catalog or executable registry
export interface ToolCallPresentation
{
  readonly label: string
  readonly summary?: string
  // MCP calls render raw pretty-JSON args and MCP approval copy
  readonly mcp: boolean
}

export type ToolArgumentValidation =
  { ok: true; args: Record<string, unknown> } | { ok: false; error: string }

// request-scoped values passed by the agent when a tool runs
export interface ToolExecutionContext
{
  cwd: string
  ollamaHost: string
  allowOutsideWorkspace?: boolean
  subagentRunner?: SubagentRunner
  codeIntel?: CodeIntelService
  todoState?: TodoState
  signal?: AbortSignal
}

// tool definition with schema and execute handler
export interface Tool
{
  name: string
  description: string
  parameters: JsonSchema
  // safe for read-only subagents; may update Coral-local caches
  subagentSafe?: boolean
  // safe to batch concurrently with other approval-free calls
  parallelSafe?: boolean
  // omitted label falls back to the tool name; omitted summarize uses compact JSON
  display?: ToolDisplay
  // override built-in coercion for tools with richer input schemas
  validateArgs?(args: Record<string, unknown>): ToolArgumentValidation
  execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<ToolResult>
}

// convert a Tool to the Ollama tool call format
export function toolToOllamaFormat(tool: Tool): OllamaTool
{
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

// estimate the separate model-tool payload that Ollama adds to the prompt
export function estimateOllamaToolTokens(tools: readonly OllamaTool[]): number
{
  return estimateModelRequestValue(tools).tokens
}

export function estimateToolDefinitionTokens(tools: readonly Tool[]): number
{
  return estimateOllamaToolTokens(tools.map(toolToOllamaFormat))
}
