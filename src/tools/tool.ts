// src/tools/tool.ts
// tool interface & conversion to Ollama format

import type { OllamaTool } from "../ollama/client.js";

// result returned after tool execution
export interface ToolResult {
  output: string;
  error?: string;
}

// tool definition w/ schema & execute handler
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

// convert a Tool to the Ollama tool call format
export function toolToOllamaFormat(tool: Tool): OllamaTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
