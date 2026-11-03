// src/tools/read.ts
// read file contents from disk

import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import { readFileGuarded } from './file-utils.js'
import { getCwd } from '../cwd.js'
import { checkWorkspacePath } from '../shared/workspace-path.js'

export const readTool: Tool = {
  name: 'read_file',
  description:
    'Read a file, optionally paging by 1-based line offset and line limit.',
  subagentSafe: true,
  parallelSafe: true,
  display: { label: 'Read', summarize: (args) => String(args.path ?? '') },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
      offset: {
        type: 'integer',
        minimum: 1,
        description: 'First line to read (1-based)',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum lines to return',
      },
    },
    required: ['path'],
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    for (const key of ['offset', 'limit'] as const)
    {
      const value = args[key]
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || (value as number) < 1)
      )
      {
        return { output: '', error: `${key} must be a positive integer` }
      }
    }
    const cwd = context?.cwd ?? getCwd()
    const allowed = await checkWorkspacePath(
      cwd,
      args.path as string | undefined,
      context?.allowOutsideWorkspace === true
    )
    if (!allowed.ok) return { output: '', error: allowed.error }

    const result = await readFileGuarded(allowed.path)
    if (!result.ok) return result.result
    context?.observeFile?.(allowed.path, result.content)
    if (args.offset === undefined && args.limit === undefined)
    {
      return { output: result.content }
    }

    // preserve line endings without counting a trailing newline as an extra line
    const lines = result.content.match(/[^\n]*\n|[^\n]+$/g) ?? []
    const offset = (args.offset as number | undefined) ?? 1
    const count = Math.min(
      (args.limit as number | undefined) ?? lines.length,
      lines.length - offset + 1
    )
    if (count <= 0)
    {
      return {
        output: `Empty page at line ${offset}; total lines: ${lines.length}.`,
      }
    }
    const end = offset + count - 1
    const next = end < lines.length ? ` Next offset: ${end + 1}.` : ''
    return {
      output: `Lines ${offset}-${end} of ${lines.length}.${next}\n${lines.slice(offset - 1, end).join('')}`,
    }
  },
}
