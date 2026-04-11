// src/tools/index.ts
// tool registry & lookup

import type { Tool } from './tool.js'
import { readTool } from './read.js'
import { writeTool } from './write.js'
import { editTool } from './edit.js'
import { grepTool } from './grep.js'
import { globTool } from './glob.js'
import { listFilesTool } from './list-files.js'
import { bashTool } from './bash.js'
import { gitStatusTool, gitDiffTool, gitLogTool } from './git.js'

// all available tools
export const allTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  grepTool,
  globTool,
  listFilesTool,
  bashTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
]

// find a tool by name
export function getToolByName(name: string): Tool | undefined
{
  return allTools.find((t) => t.name === name)
}

export type { Tool, ToolResult } from './tool.js'
export { toolToOllamaFormat } from './tool.js'
