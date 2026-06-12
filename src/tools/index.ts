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
import { searchCodeTool } from './search-code.js'
import {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitAddTool,
  gitCommitTool,
  gitPushTool,
} from './git.js'
import { taskTool } from './task.js'
import { todoWriteTool } from './todo.js'

// all available tools
export const allTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  grepTool,
  globTool,
  listFilesTool,
  searchCodeTool,
  bashTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitAddTool,
  gitCommitTool,
  gitPushTool,
  taskTool,
  todoWriteTool,
]

// read-only subset handed to research subagents — no edit, shell, commit, or
// task tools, so subagents have no side effects & cannot recurse
export const subagentTools: Tool[] = allTools.filter((t) => t.readOnly === true)

// find a tool by name
export function getToolByName(name: string): Tool | undefined
{
  return allTools.find((t) => t.name === name)
}

export type { Tool, ToolResult } from './tool.js'
export { toolToOllamaFormat } from './tool.js'
