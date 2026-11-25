// src/tools/edit.ts
// surgical find/replace file edits

import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import {
  applyEdit,
  describeEditMiss,
  type EditRefusalReason,
} from './edit-operation.js'
import { formatNotUtf8Refusal, readFileGuarded } from './file-utils.js'
import { checkWorkspacePath } from '../shared/workspace-path.js'
import { getCwd } from '../cwd.js'
import { formatBytes } from '../utils/bytes.js'
import { computeDiff } from '../utils/diff.js'
import { toErrorMessage } from '../utils/errors.js'
import { pluralize } from '../utils/pluralize.js'
import {
  overwriteRegularFile,
  TEXT_FILE_READ_LIMIT_BYTES,
} from '../utils/file-read.js'

const EMPTY_OLD_STRING_ERROR = 'old_string must not be empty'
const IDENTICAL_STRINGS_ERROR =
  'old_string & new_string are identical — nothing to change'

// explain a refused edit; whitespace-normalized refusals name the real cause so
// the model doesn't chase a "later lines differ" hint that isn't true
function formatEditRefusal(
  reason: EditRefusalReason,
  count: number,
  path: string,
  content: string,
  oldString: string
): string
{
  const normalized = `old_string matches ${path} only after normalizing whitespace`
  switch (reason)
  {
    case 'not_found':
      return `old_string not found in ${path}.${describeEditMiss(content, oldString)}`
    case 'no_change':
      return `${normalized}, & new_string differs from it only in whitespace, so the edit changes nothing. Re-read & copy the exact text incl. indentation.`
    case 'ambiguous':
      return `old_string matches ${count} places in ${path} after normalizing whitespace. Re-read & copy the exact text incl. indentation, w/ enough context to identify one match.`
    case 'repeated_lines':
      return `${normalized}, & new_string reorders or repeats its lines, so Coral can't map them to file lines. Re-read that region & copy old_string exactly incl. indentation.`
    case 'indent_mismatch':
      return `${normalized}, & tabs meet spaces in the indentation of old_string, new_string, or that file region, so changed lines can't be re-indented safely. Re-read that region & resend both strings w/ the file's exact indentation.`
    case 'multiple':
      return `Found ${count} matches in ${path} — provide more context to uniquely identify the target, or set replace_all to true`
    case 'empty':
      return EMPTY_OLD_STRING_ERROR
    case 'identical':
      return IDENTICAL_STRINGS_ERROR
  }
}

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
      return { output: '', error: EMPTY_OLD_STRING_ERROR }
    }
    if (oldString === newString)
    {
      return { output: '', error: IDENTICAL_STRINGS_ERROR }
    }

    const allowed = await checkWorkspacePath(
      cwd,
      args.path as string | undefined,
      allowOutside
    )
    if (!allowed.ok) return { output: '', error: allowed.error }

    const path = allowed.path
    const readResult = await readFileGuarded(path, { root: allowed.root })
    if (!readResult.ok) return readResult.result
    if (readResult.lossy)
    {
      return { output: '', error: formatNotUtf8Refusal('edit', path) }
    }
    const content = readResult.content

    const result = applyEdit(content, oldString, newString, replaceAll)
    if (!result.ok)
    {
      return {
        output: '',
        error: formatEditRefusal(
          result.reason,
          result.count,
          path,
          content,
          oldString
        ),
      }
    }
    const updated = result.after
    const updatedBytes = Buffer.byteLength(updated, 'utf-8')
    // fail closed for in-workspace edits; outside-workspace skips undo capture
    if (!allowOutside && updatedBytes > TEXT_FILE_READ_LIMIT_BYTES)
    {
      return {
        output: '',
        error:
          `Refusing to edit ${path}: result would be ` +
          `${formatBytes(updatedBytes)}, exceeds ` +
          `${formatBytes(TEXT_FILE_READ_LIMIT_BYTES)} undo capture limit`,
      }
    }

    try
    {
      await overwriteRegularFile(path, updated, { root: allowed.root })
      context?.observeFile?.(path, updated)
    }
    catch (err)
    {
      return {
        output: '',
        error: `Failed to write ${path}: ${toErrorMessage(err)}`,
      }
    }

    const replaced = replaceAll ? result.count : 1
    // record whitespace-tolerant recovery so the model can copy exact text next
    // time and ReliabilityStats can count the repair
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
