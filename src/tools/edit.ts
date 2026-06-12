// src/tools/edit.ts
// surgical find/replace file edits

import { writeFile } from 'node:fs/promises'
import type { Tool, ToolResult } from './tool.js'
import { readFileGuarded } from './file-utils.js'
import { resolvePath } from '../cwd.js'
import { computeDiff } from '../utils/diff.js'

// count non-overlapping occurrences of a substring
function countOccurrences(haystack: string, needle: string): number
{
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1)
  {
    count++
    pos += needle.length
  }
  return count
}

export const editTool: Tool = {
  name: 'edit_file',
  description:
    'Make surgical edits to a file by replacing exact string matches. Fails if old_string is not found or matches multiple times (unless replace_all is true).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      old_string: {
        type: 'string',
        description: 'Exact text to find & replace',
      },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: {
        type: 'boolean',
        description:
          'Replace all occurrences instead of requiring a unique match (default: false)',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args): Promise<ToolResult>
  {
    const path = resolvePath(args.path as string)
    const oldString = args.old_string as string
    const newString = args.new_string as string
    const replaceAll = (args.replace_all as boolean) ?? false

    if (!oldString)
    {
      return { output: '', error: 'old_string must not be empty' }
    }
    if (oldString === newString)
    {
      return {
        output: '',
        error: 'old_string & new_string are identical — nothing to change',
      }
    }

    const readResult = await readFileGuarded(path)
    if (!readResult.ok) return readResult.result
    const content = readResult.content

    const count = countOccurrences(content, oldString)

    if (count === 0)
    {
      return { output: '', error: `old_string not found in ${path}` }
    }
    if (count > 1 && !replaceAll)
    {
      return {
        output: '',
        error: `Found ${count} matches in ${path} — provide more context to uniquely identify the target, or set replace_all to true`,
      }
    }

    const updated = replaceAll
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString)

    try
    {
      await writeFile(path, updated, 'utf-8')
    }
    catch (err)
    {
      return { output: '', error: `Failed to write ${path}: ${err}` }
    }

    const replaced = replaceAll ? count : 1
    return {
      output: `Edited ${path}: replaced ${replaced} occurrence${replaced > 1 ? 's' : ''} (${oldString.length} chars → ${newString.length} chars)`,
      diff: computeDiff(content, updated) ?? undefined,
    }
  },
}
