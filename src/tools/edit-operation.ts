// src/tools/edit-operation.ts
// pure edit_file transformation & miss diagnosis

// edit_file's pure mutation: validates preconditions & computes the post-edit
// string. shared by editTool.execute & the approval preview so they can't drift
export type ApplyEditResult =
  | { ok: true; after: string; count: number; matchType: 'exact' | 'fuzzy' }
  | {
      ok: false
      reason: 'empty' | 'identical' | 'not_found' | 'multiple'
      count: number
    }

// leading whitespace (spaces/tabs) of a line — used to re-base fuzzy matches
function leadingWhitespace(line: string): string
{
  const match = line.match(/^[ \t]*/)
  return match ? match[0] : ''
}

// per-line key for whitespace-tolerant matching: drop a trailing CR & trim both
// ends, so indentation / trailing-space / CRLF drift can't block a match
function editLineKey(line: string): string
{
  return line.replace(/\r$/, '').trim()
}

// split into content lines, dropping the trailing '' a final newline produces
// (it's a boundary, not a line to match or replace)
function contentLines(text: string): string[]
{
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// re-base a genuinely new/changed replacement line onto the file's indent,
// preserving the line's own relative indentation. shift columns by the file-vs-
// old base delta; unchanged lines never reach here (they reuse the file verbatim)
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

// whitespace-tolerant fallback for applyEdit: match old_string as a block of
// lines compared by editLineKey, then splice in new_string. an unchanged line is
// re-emitted from the file verbatim (its real indent & line ending survive); only
// changed/new lines get re-indented. refuses an ambiguous match (returns null) so
// a loose match can't hit the wrong block. null = no confident match; caller
// keeps the exact 'not_found'
function applyFuzzyEdit(
  before: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): { after: string; count: number } | null
{
  const beforeLines = before.split('\n')
  const oldLines = contentLines(oldString)
  // an empty new_string is a deletion — drop the block, don't leave a blank line
  // (contentLines('') would yield [''] & splice a stray line in)
  const newLines = newString === '' ? [] : contentLines(newString)
  if (oldLines.length === 0) return null

  const oldKeys = oldLines.map(editLineKey)
  // an all-blank old_string has no content to anchor on — it would match any
  // blank-line run. refuse so the caller reports not_found instead of injecting
  if (oldKeys.every((key) => key === '')) return null

  // collect non-overlapping block matches (mirrors String.replaceAll's
  // non-overlap so overlapping splices can't clobber each other)
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
  // splice from last to first so earlier indices stay valid
  for (let k = targets.length - 1; k >= 0; k--)
  {
    const start = targets[k]
    const fileLines = beforeLines.slice(start, start + oldLines.length)
    const fileIndent = leadingWhitespace(fileLines[0])
    const useCrlf = fileLines.some((line) => line.endsWith('\r'))
    // map an unchanged line (by normalized key) back to its exact file text so
    // its real indentation & line ending survive verbatim
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
  // a whitespace-only no-op isn't a real edit — let the caller report a miss
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
  // non-overlapping occurrence count
  const count = before.split(oldString).length - 1
  if (count > 1 && !replaceAll) return { ok: false, reason: 'multiple', count }
  if (count >= 1)
  {
    const after = replaceAll
      ? before.replaceAll(oldString, newString)
      : before.replace(oldString, newString)
    return { ok: true, after, count, matchType: 'exact' }
  }
  // exact miss: try a whitespace-tolerant block match before giving up, so a
  // weak model that drifted indentation/trailing-space can still land the edit
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

// short, honest hint for an edit_file miss (after fuzzy matching also failed):
// point at where old_string's first line does or doesn't appear in the file
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
