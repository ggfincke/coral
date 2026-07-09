// src/tools/write.ts
// write content to a file, creating directories as needed

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import { checkWorkspacePath } from './path-policy.js'
import { getCwd } from '../cwd.js'
import { formatBytes } from '../utils/bytes.js'
import { computeDiff } from '../utils/diff.js'
import { toErrorMessage } from '../utils/errors.js'
import {
  formatDiffSkipMessage,
  readOptionalPreviousTextFile,
  TEXT_FILE_READ_LIMIT_BYTES,
} from '../utils/file-read.js'

function undoChangeFor(
  path: string,
  before: Awaited<ReturnType<typeof readOptionalPreviousTextFile>>,
  after: string
): ToolResult['change']
{
  if (!before.ok) return undefined
  if (after.length > TEXT_FILE_READ_LIMIT_BYTES) return undefined
  return {
    path,
    before: before.existed ? before.content : null,
    after,
  }
}

export const writeTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file, creating directories as needed.',
  display: { label: 'Write', summarize: (args) => String(args.path ?? '') },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write to' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const cwd = context?.cwd ?? getCwd()
    const rawPath = args.path as string
    const content = args.content as string
    let path = rawPath
    try
    {
      const allowed = await checkWorkspacePath(
        cwd,
        rawPath,
        context?.allowOutsideWorkspace === true
      )
      if (!allowed.ok) return { output: '', error: allowed.error }

      path = allowed.path
      const before = await readOptionalPreviousTextFile(path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf-8')
      const output = `Wrote ${formatBytes(content.length)} to ${path}`
      if (!before.ok)
      {
        return {
          output: `${output}\n${formatDiffSkipMessage(before)}`,
        }
      }

      return {
        output,
        diff: computeDiff(before.content, content) ?? undefined,
        change: undoChangeFor(path, before, content),
      }
    }
    catch (err)
    {
      return {
        output: '',
        error: `Failed to write ${path}: ${toErrorMessage(err)}`,
      }
    }
  },
}
