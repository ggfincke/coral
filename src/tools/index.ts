// src/tools/index.ts
// tool registry & lookup

import type { Tool } from "./tool.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { bashTool } from "./bash.js";

// all available tools
export const allTools: Tool[] = [readTool, writeTool, bashTool];

// find a tool by name
export function getToolByName(name: string): Tool | undefined {
  return allTools.find((t) => t.name === name);
}

export type { Tool, ToolResult } from "./tool.js";
export { toolToOllamaFormat } from "./tool.js";
