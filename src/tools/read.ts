// src/tools/read.ts
// read file contents from disk

import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import { readFileGuarded } from './file-utils.js'
import { getCwd } from '../cwd.js'
import { checkWorkspacePath } from './path-policy.js'

export const readTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file at the given path.',
  subagentSafe: true,
  parallelSafe: true,
  display: { label: 'Read', summarize: (args) => String(args.path ?? '') },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
    },
    required: ['path'],
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const cwd = context?.cwd ?? getCwd()
    const allowed = await checkWorkspacePath(
      cwd,
      args.path as string | undefined,
      context?.allowOutsideWorkspace === true
    )
    if (!allowed.ok) return { output: '', error: allowed.error }

    const result = await readFileGuarded(allowed.path)
    if (!result.ok) return result.result
    return { output: result.content }
  },
}
