// src/tui/prompt/prompt-render.ts
// multi-line prompt cursor rendering w/ a bounded scroll window

import chalk from 'chalk'
import { buildLineStarts, locateOffset } from './line-index.js'

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
})

// visual rows shown for a draft regardless of how many logical lines it has
export const MAX_PROMPT_VIEW_ROWS = 8

export interface PromptCursorSegment
{
  text: string
  highlighted: boolean
}

export function buildPromptCursorSegments(
  value: string,
  cursorOffset: number,
  cursorWidth: number
): PromptCursorSegment[]
{
  const selectionStart = cursorOffset - cursorWidth
  const segments: PromptCursorSegment[] = []

  for (const segment of GRAPHEME_SEGMENTER.segment(value))
  {
    const start = segment.index
    const end = start + segment.segment.length
    const highlighted =
      cursorWidth > 0
        ? start >= selectionStart && start < cursorOffset
        : start === cursorOffset || (start < cursorOffset && cursorOffset < end)

    segments.push({ text: segment.segment, highlighted })
  }

  return segments
}

// rendered row count for layout math: logical lines capped to the window
export function countPromptRenderRows(value: string): number
{
  return Math.min(value.split('\n').length, MAX_PROMPT_VIEW_ROWS)
}

// render the draft as visible rows joined by newlines; the fake cursor rides
// only the cursor's own row & long drafts scroll around it (top clip marked)
export function renderPromptValueWithCursor(
  value: string,
  cursorOffset: number,
  cursorWidth: number,
  maxRows: number = MAX_PROMPT_VIEW_ROWS
): string
{
  if (value.length === 0) return chalk.inverse(' ')

  // style every grapheme once, splitting rows on newlines; a cursor sitting
  // on a newline renders as a caret block at that line's end
  const rows: string[] = []
  let current = ''
  for (const segment of buildPromptCursorSegments(
    value,
    cursorOffset,
    cursorWidth
  ))
  {
    if (segment.text === '\n')
    {
      if (segment.highlighted) current += chalk.inverse(' ')
      rows.push(current)
      current = ''
      continue
    }
    current += segment.highlighted ? chalk.inverse(segment.text) : segment.text
  }
  rows.push(current)

  if (cursorOffset === value.length)
  {
    rows[rows.length - 1] += chalk.inverse(' ')
  }

  const { row } = locateOffset(buildLineStarts(value), cursorOffset)
  let firstRow = 0
  if (rows.length > maxRows)
  {
    firstRow = Math.max(
      0,
      Math.min(row - Math.floor((maxRows - 1) / 2), rows.length - maxRows)
    )
  }

  const visible = rows.slice(firstRow, firstRow + maxRows)
  if (firstRow > 0 && visible[0] !== undefined)
  {
    visible[0] = `…${visible[0]}`
  }

  return visible.join('\n')
}
