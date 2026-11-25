// src/tools/edit-operation.ts
// apply edit preconditions and compute the post-edit string

// why an edit was refused; ambiguous, no_change, repeated_lines &
// indent_mismatch come from a whitespace-normalized match Coral can't apply safely
export type EditRefusalReason =
  | 'empty'
  | 'identical'
  | 'not_found'
  | 'multiple'
  | 'ambiguous'
  | 'no_change'
  | 'repeated_lines'
  | 'indent_mismatch'

// share this transformation between editTool.execute and the approval preview
export type ApplyEditResult =
  | { ok: true; after: string; count: number; matchType: 'exact' | 'fuzzy' }
  | { ok: false; reason: EditRefusalReason; count: number }

// capture a line's leading whitespace for fuzzy-match re-basing
function leadingWhitespace(line: string): string
{
  const match = line.match(/^[^\S\r\n]*/)
  return match ? match[0] : ''
}

// normalize a line for whitespace-tolerant matching by dropping a trailing CR and
// trimming both ends
function editLineKey(line: string): string
{
  return line.replace(/\r$/, '').trim()
}

// retain indentation when identifying unchanged replacement lines
function retainedLineKey(line: string): string
{
  return line.replace(/\r$/, '').trimEnd()
}

// use prefix fallback to scan repetitive blocks without rescanning their lines
function findBlockStarts(beforeKeys: string[], oldKeys: string[]): number[]
{
  const prefixes = new Array<number>(oldKeys.length).fill(0)
  for (let i = 1, matched = 0; i < oldKeys.length; i++)
  {
    while (matched > 0 && oldKeys[i] !== oldKeys[matched])
    {
      matched = prefixes[matched - 1]
    }
    if (oldKeys[i] === oldKeys[matched]) matched++
    prefixes[i] = matched
  }

  const starts: number[] = []
  for (let i = 0, matched = 0; i < beforeKeys.length; i++)
  {
    while (matched > 0 && beforeKeys[i] !== oldKeys[matched])
    {
      matched = prefixes[matched - 1]
    }
    if (beforeKeys[i] === oldKeys[matched]) matched++
    if (matched === oldKeys.length)
    {
      starts.push(i - oldKeys.length + 1)
      // restart after accepted blocks to preserve leftmost non-overlap
      matched = 0
    }
  }
  return starts
}

// bound every retained line's possible source positions through ordered anchors
function retainedLineBounds(
  oldKeys: string[],
  newKeys: string[]
): { earliest: number[]; latest: number[] } | null
{
  const knownKeys = new Set(oldKeys)
  const earliest = new Array<number>(newKeys.length).fill(-1)
  const latest = new Array<number>(newKeys.length).fill(-1)
  let cursor = 0
  for (let i = 0; i < newKeys.length; i++)
  {
    if (!knownKeys.has(newKeys[i])) continue
    while (cursor < oldKeys.length && oldKeys[cursor] !== newKeys[i]) cursor++
    if (cursor === oldKeys.length) return null
    earliest[i] = cursor++
  }
  cursor = oldKeys.length - 1
  for (let i = newKeys.length - 1; i >= 0; i--)
  {
    if (!knownKeys.has(newKeys[i])) continue
    while (cursor >= 0 && oldKeys[cursor] !== newKeys[i]) cursor--
    latest[i] = cursor--
  }
  return { earliest, latest }
}

// split into content lines and drop the trailing '' from a final newline
// (it's a boundary, not a line to match or replace)
function contentLines(text: string): string[]
{
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// report whether old_string & the matched file lines indent a corresponding line
// w/ different units; compare line by line so alignment spaces on one line (a
// column-0 JSDoc ` * `, a Makefile continuation) don't stand in for the file's unit
function indentUnitsDiffer(oldLines: string[], fileLines: string[]): boolean
{
  for (let i = 0; i < oldLines.length; i++)
  {
    if (oldLines[i].trim() === '') continue
    const oldUnit = leadingWhitespace(oldLines[i])[0]
    const fileUnit = leadingWhitespace(fileLines[i])[0]
    if (oldUnit && fileUnit && oldUnit !== fileUnit) return true
  }
  return false
}

// re-base a changed replacement line onto the file's indentation while preserving
// its relative indentation; unchanged lines reuse the file verbatim. returns null
// when indents use different units, since adding their counts would mix them
function reindentNewLine(
  line: string,
  oldIndent: string,
  fileIndent: string,
  unitsDiffer: boolean
): string | null
{
  const lineIndent = leadingWhitespace(line)
  const body = line.slice(lineIndent.length)
  if (lineIndent === oldIndent) return fileIndent + body
  if (unitsDiffer) return null
  // a deeper line keeps its extra indent verbatim, so alignment spaces after a
  // tab stay spaces instead of being counted as tabs
  if (lineIndent.startsWith(oldIndent))
  {
    return fileIndent + lineIndent.slice(oldIndent.length) + body
  }
  // otherwise compare leading units only
  const units = new Set(
    [oldIndent[0], lineIndent[0], fileIndent[0]].filter(Boolean)
  )
  if (units.size > 1) return null
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
): ApplyEditResult
{
  const refuse = (reason: EditRefusalReason, count = 0): ApplyEditResult => ({
    ok: false,
    reason,
    count,
  })
  const beforeLines = before.split('\n')
  const oldLines = contentLines(oldString)
  // treat an empty replacement as deletion instead of splicing a stray blank line
  const newLines =
    newString === ''
      ? []
      : contentLines(newString).map((line) => line.replace(/\r$/, ''))
  if (oldLines.length === 0) return refuse('not_found')

  const oldKeys = oldLines.map(editLineKey)
  // reject an all-blank old_string because it can match any blank-line run
  if (oldKeys.every((key) => key === '')) return refuse('not_found')

  const starts = findBlockStarts(beforeLines.map(editLineKey), oldKeys)
  if (starts.length === 0) return refuse('not_found')
  if (starts.length > 1 && !replaceAll)
  {
    return refuse('ambiguous', starts.length)
  }

  const retainedKeys = oldLines.map(retainedLineKey)
  const bounds = retainedLineBounds(retainedKeys, newLines.map(retainedLineKey))
  if (!bounds) return refuse('repeated_lines')
  // base indentation on the first non-blank line; a leading blank has none
  const baseLine = oldKeys.findIndex((key) => key !== '')
  const oldIndent = leadingWhitespace(oldLines[baseLine])
  const result: string[] = []
  let cursor = 0
  for (const start of starts)
  {
    const fileLines = beforeLines.slice(start, start + oldLines.length)
    const fileIndent = leadingWhitespace(fileLines[baseLine])
    const unitsDiffer = indentUnitsDiffer(oldLines, fileLines)
    const useCrlf = fileLines.some((line) => line.endsWith('\r'))
    // count source-text changes per key so an interval check never rescans a run
    const changes = new Array<number>(oldLines.length)
    const lastByKey = new Map<string, number>()
    for (let j = 0; j < oldLines.length; j++)
    {
      const previous = lastByKey.get(retainedKeys[j])
      changes[j] =
        previous === undefined
          ? 0
          : changes[previous] + Number(fileLines[previous] !== fileLines[j])
      lastByKey.set(retainedKeys[j], j)
    }
    for (; cursor < start; cursor++) result.push(beforeLines[cursor])
    for (let j = 0; j < newLines.length; j++)
    {
      const earliest = bounds.earliest[j]
      if (earliest >= 0)
      {
        // repeated anchors may be interchangeable only when their bytes agree
        if (changes[earliest] !== changes[bounds.latest[j]])
        {
          return refuse('repeated_lines')
        }
        result.push(fileLines[earliest])
        continue
      }
      const line = newLines[j]
      if (line.trim() === '')
      {
        result.push(useCrlf ? '\r' : '')
        continue
      }
      const rebased = reindentNewLine(line, oldIndent, fileIndent, unitsDiffer)
      if (rebased === null) return refuse('indent_mismatch')
      result.push(useCrlf ? `${rebased}\r` : rebased)
    }
    cursor = start + oldLines.length
  }
  for (; cursor < beforeLines.length; cursor++) result.push(beforeLines[cursor])

  const after = result.join('\n')
  // report whitespace-only no-ops instead of writing an unchanged file
  if (after === before) return refuse('no_change')
  return { ok: true, after, count: starts.length, matchType: 'fuzzy' }
}

// true when every line break in the file is CRLF & no lone CR exists; only
// then do exact edits rewrite new_string to CRLF (mixed files keep it as sent)
function isAllCrlf(before: string): boolean
{
  return before.includes('\r\n') && !/(?<!\r)\n|\r(?!\n)/.test(before)
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
    let target = oldString
    let inserted = newString
    if (isAllCrlf(before))
    {
      // widen a match that splits a CRLF pair to the whole pair, so the
      // replacement never leaves a bare LF or a lone CR behind
      if (target.startsWith('\n')) target = `\r${target}`
      if (target.endsWith('\r'))
      {
        target = `${target}\n`
        inserted = `${inserted}\n`
      }
      inserted = inserted.replace(/(?<!\r)\n/g, '\r\n')
    }
    const after = replaceAll
      ? before.replaceAll(target, () => inserted)
      : before.replace(target, () => inserted)
    return { ok: true, after, count, matchType: 'exact' }
  }
  // try a whitespace-tolerant block match after an exact miss
  return applyFuzzyEdit(before, oldString, newString, replaceAll)
}

// describe the first-line mismatch after exact and fuzzy matching fail; a
// single-line old_string that matches on whitespace never gets here because the
// fuzzy path finds it
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
      return ` old_string's first line matches file line ${i + 1}, but later lines differ — re-read that region & copy it exactly.`
    }
  }
  return " No file line matches old_string's first line — re-read the file to copy the exact text."
}
