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
  readOptionalPreviousTextFile,
  TEXT_FILE_READ_LIMIT_BYTES,
} from '../utils/file-read.js'

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
    const contentBytes = Buffer.byteLength(content, 'utf-8')
    const allowOutside = context?.allowOutsideWorkspace === true
    let path = rawPath
    try
    {
      const allowed = await checkWorkspacePath(cwd, rawPath, allowOutside)
      if (!allowed.ok) return { output: '', error: allowed.error }

      path = allowed.path
      // approved outside-workspace writes are allowed but never undo-captured
      // (replay refuses outside-workspace paths)
      if (allowOutside)
      {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content, 'utf-8')
        return {
          output:
            `Wrote ${formatBytes(contentBytes)} to ${path} ` +
            `(not undoable (outside workspace))`,
        }
      }

      // fail closed: refuse when undo cannot snapshot before/after
      if (contentBytes > TEXT_FILE_READ_LIMIT_BYTES)
      {
        return {
          output: '',
          error:
            `Refusing to write ${path}: content is ` +
            `${formatBytes(contentBytes)}, exceeds ` +
            `${formatBytes(TEXT_FILE_READ_LIMIT_BYTES)} undo capture limit`,
        }
      }

      const before = await readOptionalPreviousTextFile(path)
      if (!before.ok)
      {
        return {
          output: '',
          error:
            `Refusing to write ${path}: cannot capture undo snapshot ` +
            `(${before.message})`,
        }
      }

      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf-8')
      return {
        output: `Wrote ${formatBytes(contentBytes)} to ${path}`,
        diff: computeDiff(before.content, content) ?? undefined,
        change: {
          path,
          before: before.existed ? before.content : null,
          after: content,
        },
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
