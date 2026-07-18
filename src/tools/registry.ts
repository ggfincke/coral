// src/tools/registry.ts
// compose and validate built-in executable tools and the subagent subset

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
  gitSwitchTool,
  gitPushTool,
} from './git.js'
import { taskTool } from './task.js'
import { todoWriteTool } from './todo.js'
import { codeIntelTool } from './code-intel.js'
import { assertBuiltInToolsRegistered, ToolCatalog } from './catalog.js'

// all available tools
export const allTools: readonly Tool[] = Object.freeze([
  readTool,
  writeTool,
  editTool,
  grepTool,
  globTool,
  listFilesTool,
  searchCodeTool,
  codeIntelTool,
  bashTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitAddTool,
  gitCommitTool,
  gitSwitchTool,
  gitPushTool,
  taskTool,
  todoWriteTool,
])

assertBuiltInToolsRegistered(allTools)

const builtInCatalog = new ToolCatalog({ trustedTools: allTools })

// expose a read-only subset to research subagents so they cannot mutate state or
// recurse
export const subagentTools: readonly Tool[] = builtInCatalog.subagentTools
