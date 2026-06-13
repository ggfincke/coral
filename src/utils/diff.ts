// src/utils/diff.ts
// unified diff generation for file edits & approval previews

import { readFile } from 'node:fs/promises'
import { structuredPatch } from 'diff'
import { resolvePath } from '../cwd.js'

// skip diffing sources past this size — generation cost outweighs the value
const MAX_DIFF_SOURCE_CHARS = 1_000_000
// cap emitted diff lines; remaining changes collapse into a summary marker
const MAX_DIFF_LINES = 200
// hunk context lines (git default)
const DIFF_CONTEXT = 3

// sniff the leading slice for null bytes or utf-8 decode replacements —
// good enough binary heuristic
function isBinary(content: string): boolean
{
  const head = content.slice(0, 8192)
  return head.includes('\0') || head.includes('�')
}

// build a unified diff body (hunk headers + lines) or null when there is
// nothing displayable: no changes, binary content, or oversized input
export function computeDiff(before: string, after: string): string | null
{
  if (before === after) return null
  if (
    before.length > MAX_DIFF_SOURCE_CHARS ||
    after.length > MAX_DIFF_SOURCE_CHARS
  )
  {
    return null
  }
  if (isBinary(before) || isBinary(after)) return null

  const patch = structuredPatch('', '', before, after, '', '', {
    context: DIFF_CONTEXT,
  })
  if (patch.hunks.length === 0) return null

  const lines: string[] = []
  let truncatedChanges = 0

  for (const hunk of patch.hunks)
  {
    const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    for (const line of [header, ...hunk.lines])
    {
      if (lines.length >= MAX_DIFF_LINES)
      {
        if (line.startsWith('+') || line.startsWith('-')) truncatedChanges++
        continue
      }
      lines.push(line)
    }
  }

  if (truncatedChanges > 0)
  {
    lines.push(`… +${truncatedChanges} more changed lines`)
  }

  return lines.join('\n')
}

// edit_file's pure mutation: validates preconditions & computes the post-edit
// string. shared by editTool.execute & the approval preview so they can't drift
export type ApplyEditResult =
  | { ok: true; after: string; count: number }
  | {
      ok: false
      reason: 'empty' | 'identical' | 'not_found' | 'multiple'
      count: number
    }

export function applyEdit(
  before: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): ApplyEditResult
{
  if (!oldString) return { ok: false, reason: 'empty', count: 0 }
  if (oldString === newString)
  {
    return { ok: false, reason: 'identical', count: 0 }
  }
  // non-overlapping occurrence count
  const count = before.split(oldString).length - 1
  if (count === 0) return { ok: false, reason: 'not_found', count }
  if (count > 1 && !replaceAll) return { ok: false, reason: 'multiple', count }
  const after = replaceAll
    ? before.replaceAll(oldString, newString)
    : before.replace(oldString, newString)
  return { ok: true, after, count }
}

// best-effort pre-execution diff for the approval box — mirrors what
// write_file/edit_file would do w/o touching disk; null means no preview
export async function previewToolDiff(
  toolName: string,
  args: Record<string, unknown>
): Promise<string | null>
{
  try
  {
    if (toolName === 'write_file')
    {
      const path = resolvePath(String(args.path ?? ''))
      const before = await readFile(path, 'utf-8').catch(() => '')
      return computeDiff(before, String(args.content ?? ''))
    }

    if (toolName === 'edit_file')
    {
      const path = resolvePath(String(args.path ?? ''))
      const before = await readFile(path, 'utf-8').catch(() => null)
      if (before === null) return null
      const result = applyEdit(
        before,
        String(args.old_string ?? ''),
        String(args.new_string ?? ''),
        Boolean(args.replace_all)
      )
      return result.ok ? computeDiff(before, result.after) : null
    }
  }
  catch
  {
    // preview failures must never block the approval prompt
  }

  return null
}
