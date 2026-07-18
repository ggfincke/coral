// src/utils/diff.ts
// unified diff generation for file changes

import { structuredPatch } from 'diff'

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
