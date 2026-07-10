// src/tools/edit.ts
// surgical find/replace file edits

import { writeFile } from 'node:fs/promises'
import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import { readFileGuarded } from './file-utils.js'
import { checkWorkspacePath } from './path-policy.js'
import { getCwd } from '../cwd.js'
import { applyEdit, computeDiff, describeEditMiss } from '../utils/diff.js'
import { formatBytes } from '../utils/bytes.js'
import { toErrorMessage } from '../utils/errors.js'
import { pluralize } from '../utils/pluralize.js'
import { TEXT_FILE_READ_LIMIT_BYTES } from '../utils/file-read.js'

export const editTool: Tool = {
  name: 'edit_file',
  description:
    'Make surgical edits to a file by replacing exact string matches. Fails if old_string is not found or matches multiple times (unless replace_all is true).',
  display: { label: 'Edit', summarize: (args) => String(args.path ?? '') },
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
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const cwd = context?.cwd ?? getCwd()
    const oldString = args.old_string as string
    const newString = args.new_string as string
    const replaceAll = (args.replace_all as boolean) ?? false
    const allowOutside = context?.allowOutsideWorkspace === true

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

    const allowed = await checkWorkspacePath(
      cwd,
      args.path as string | undefined,
      allowOutside
    )
    if (!allowed.ok) return { output: '', error: allowed.error }

    const path = allowed.path
    const readResult = await readFileGuarded(path)
    if (!readResult.ok) return readResult.result
    const content = readResult.content

    const result = applyEdit(content, oldString, newString, replaceAll)
    if (!result.ok)
    {
      if (result.reason === 'not_found')
      {
        return {
          output: '',
          error: `old_string not found in ${path}.${describeEditMiss(content, oldString)}`,
        }
      }
      return {
        output: '',
        error: `Found ${result.count} matches in ${path} — provide more context to uniquely identify the target, or set replace_all to true`,
      }
    }
    const updated = result.after
    // fail closed for in-workspace edits; outside-workspace skips undo capture
    if (!allowOutside && updated.length > TEXT_FILE_READ_LIMIT_BYTES)
    {
      return {
        output: '',
        error:
          `Refusing to edit ${path}: result would be ` +
          `${formatBytes(updated.length)}, exceeds ` +
          `${formatBytes(TEXT_FILE_READ_LIMIT_BYTES)} undo capture limit`,
      }
    }

    try
    {
      await writeFile(path, updated, 'utf-8')
    }
    catch (err)
    {
      return {
        output: '',
        error: `Failed to write ${path}: ${toErrorMessage(err)}`,
      }
    }

    const replaced = replaceAll ? result.count : 1
    // fuzzy match = old_string didn't match verbatim; tell the model so it copies
    // exact text next time, & flag the recovery for ReliabilityStats
    const fuzzy = result.matchType === 'fuzzy'
    const note = fuzzy
      ? ' (old_string matched on normalized whitespace, not verbatim — copy exact text next time)'
      : ''
    const outsideNote = allowOutside
      ? ' (not undoable (outside workspace))'
      : ''
    return {
      output:
        `Edited ${path}: replaced ${pluralize(replaced, 'occurrence')} ` +
        `(${oldString.length} chars → ${newString.length} chars)${note}${outsideNote}`,
      diff: computeDiff(content, updated) ?? undefined,
      // approved outside-workspace edits are never undo-captured
      ...(allowOutside
        ? {}
        : { change: { path, before: content, after: updated } }),
      repaired: fuzzy,
    }
  },
}
