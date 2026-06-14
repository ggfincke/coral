// src/tools/tool.ts
// tool interface & conversion to Ollama format

import type { OllamaTool, JsonSchema } from '../types/inference.js'

// result returned after tool execution
export interface ToolResult
{
  output: string
  error?: string
  // unified diff of a file change — TUI display only, never sent to the model
  diff?: string
}

// TUI presentation metadata — single source of truth for the tool's header
// label & one-line arg summary, so renderers don't keep per-tool string ladders
export interface ToolDisplay
{
  label: string
  summarize?(args: Record<string, unknown>): string
}

// tool definition w/ schema & execute handler
export interface Tool
{
  name: string
  description: string
  parameters: JsonSchema
  // read-only tools have no side effects — safe to batch & run in parallel
  readOnly?: boolean
  // omitted label falls back to the tool name; omitted summarize to compact JSON
  display?: ToolDisplay
  execute(args: Record<string, unknown>): Promise<ToolResult>
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
