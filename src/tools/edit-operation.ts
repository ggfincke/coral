// src/tools/edit-operation.ts
// apply edit preconditions and compute the post-edit string

// share this transformation between editTool.execute and the approval preview
export type ApplyEditResult =
  | { ok: true; after: string; count: number; matchType: 'exact' | 'fuzzy' }
  | {
      ok: false
      reason: 'empty' | 'identical' | 'not_found' | 'multiple'
      count: number
    }

// capture a line's leading whitespace for fuzzy-match re-basing
function leadingWhitespace(line: string): string
{
  const match = line.match(/^[ \t]*/)
  return match ? match[0] : ''
}

// normalize a line for whitespace-tolerant matching by dropping a trailing CR and
// trimming both ends
function editLineKey(line: string): string
{
  return line.replace(/\r$/, '').trim()
}

// split into content lines and drop the trailing '' from a final newline
// (it's a boundary, not a line to match or replace)
function contentLines(text: string): string[]
{
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// re-base a changed replacement line onto the file's indentation while preserving
// its relative indentation; unchanged lines reuse the file verbatim
function reindentNewLine(
  line: string,
  oldIndent: string,
  fileIndent: string
): string
{
  const lineIndent = leadingWhitespace(line)
  const body = line.slice(lineIndent.length)
  const cols = Math.max(
    0,
    fileIndent.length + lineIndent.length - oldIndent.length
  )
  const unit = fileIndent[0] ?? lineIndent[0] ?? ' '
  return unit.repeat(cols) + body
}

// match an edit block by normalized lines, preserving unchanged file text and
// refusing ambiguous matches
function applyFuzzyEdit(
  before: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): { after: string; count: number } | null
{
  const beforeLines = before.split('\n')
  const oldLines = contentLines(oldString)
  // treat an empty replacement as deletion instead of splicing a stray blank line
  const newLines = newString === '' ? [] : contentLines(newString)
  if (oldLines.length === 0) return null

  const oldKeys = oldLines.map(editLineKey)
  // reject an all-blank old_string because it can match any blank-line run
  if (oldKeys.every((key) => key === '')) return null

  // collect non-overlapping block matches so overlapping splices cannot clobber
  // one another
  const starts: number[] = []
  let prevEnd = -1
  for (let i = 0; i + oldLines.length <= beforeLines.length; i++)
  {
    let hit = true
    for (let j = 0; j < oldLines.length; j++)
    {
      if (editLineKey(beforeLines[i + j]) !== oldKeys[j])
      {
        hit = false
        break
      }
    }
    if (hit && i > prevEnd)
    {
      starts.push(i)
      prevEnd = i + oldLines.length - 1
    }
  }

  if (starts.length === 0) return null
  if (starts.length > 1 && !replaceAll) return null

  const targets = replaceAll ? starts : [starts[0]]
  const oldIndent = leadingWhitespace(oldLines[0])
  const result = beforeLines.slice()
  // splice from last to first so earlier indices remain valid
  for (let k = targets.length - 1; k >= 0; k--)
  {
    const start = targets[k]
    const fileLines = beforeLines.slice(start, start + oldLines.length)
    const fileIndent = leadingWhitespace(fileLines[0])
    const useCrlf = fileLines.some((line) => line.endsWith('\r'))
    // map unchanged lines back to their exact file text so indentation and line
    // endings survive verbatim
    const keyToFileLine = new Map<string, string>()
    for (let j = 0; j < oldLines.length; j++)
    {
      if (!keyToFileLine.has(oldKeys[j]))
      {
        keyToFileLine.set(oldKeys[j], fileLines[j])
      }
    }
    const reindented = newLines.map((line) =>
    {
      const original = keyToFileLine.get(editLineKey(line))
      if (original !== undefined) return original
      if (line.trim() === '') return useCrlf ? '\r' : ''
      const rebased = reindentNewLine(line, oldIndent, fileIndent)
      return useCrlf ? `${rebased}\r` : rebased
    })
    result.splice(start, oldLines.length, ...reindented)
  }

  const after = result.join('\n')
  // report whitespace-only no-ops as misses
  if (after === before) return null
  return { after, count: targets.length }
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
  // count non-overlapping occurrences
  const count = before.split(oldString).length - 1
  if (count > 1 && !replaceAll) return { ok: false, reason: 'multiple', count }
  if (count >= 1)
  {
    const after = replaceAll
      ? before.replaceAll(oldString, newString)
      : before.replace(oldString, newString)
    return { ok: true, after, count, matchType: 'exact' }
  }
  // try a whitespace-tolerant block match after an exact miss
  const fuzzy = applyFuzzyEdit(before, oldString, newString, replaceAll)
  if (fuzzy)
  {
    return {
      ok: true,
      after: fuzzy.after,
      count: fuzzy.count,
      matchType: 'fuzzy',
    }
  }
  return { ok: false, reason: 'not_found', count: 0 }
}

// describe the first-line mismatch after exact and fuzzy matching fail
export function describeEditMiss(before: string, oldString: string): string
{
  const lines = contentLines(oldString)
  const firstNonBlank = lines.find((line) => line.trim() !== '')
  if (!firstNonBlank) return ''
  const target = firstNonBlank.trim()
  const beforeLines = before.split('\n')
  for (let i = 0; i < beforeLines.length; i++)
  {
    if (beforeLines[i].trim() === target)
    {
      if (lines.length === 1)
      {
        return ` old_string's line matches file line ${i + 1} on whitespace alone but changes nothing — re-read & copy the exact text incl. indentation.`
      }
      return ` old_string's first line matches file line ${i + 1}, but later lines differ — re-read that region & copy it exactly.`
    }
  }
  return " No file line matches old_string's first line — re-read the file to copy the exact text."
}
