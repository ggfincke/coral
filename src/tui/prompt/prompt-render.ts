// src/tui/prompt/prompt-render.ts
// multi-line prompt cursor rendering w/ a bounded scroll window

import chalk from 'chalk'
import stringWidth from 'string-width'
import {
  isUnsafeTerminalControl,
  sanitizeUntrustedText,
} from '../../utils/untrusted-text.js'

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

// fit plain menu/hint text without splitting a displayed grapheme
export function fitPromptLine(value: string, width: number): string
{
  const text = sanitizeUntrustedText(value).replace(/[\n\t]/g, ' ')
  const limit = Math.max(0, Math.floor(width))
  if (stringWidth(text) <= limit) return text
  if (limit === 0) return ''

  let fitted = ''
  let cells = 0
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text))
  {
    const next = stringWidth(segment)
    if (cells + next > limit - 1) break
    fitted += segment
    cells += next
  }
  return fitted + '…'
}

export interface PromptRenderModel
{
  rows: string[]
  cursorRow: number
}

// wrap before clipping so the window follows terminal rows, including the
// extra cursor cell at an exact-width line ending
export function buildPromptRenderModel(
  value: string,
  cursorOffset: number,
  cursorWidth: number,
  width = Number.POSITIVE_INFINITY,
  maxRows = MAX_PROMPT_VIEW_ROWS,
  showCursor = true
): PromptRenderModel
{
  const columnLimit = Math.max(1, Math.floor(width))
  const rowLimit = Math.max(
    1,
    Math.min(MAX_PROMPT_VIEW_ROWS, Math.floor(maxRows))
  )
  const rows: PromptCursorSegment[][] = [[]]
  let cells = 0
  let cursorRow = 0
  const pushRow = () =>
  {
    rows.push([])
    cells = 0
  }
  const append = (segment: PromptCursorSegment) =>
  {
    // external editor text can contain controls; render their location without
    // letting them move the terminal cursor or hide the fake cursor cell
    const safeText = [...segment.text]
      .map((character) =>
        isUnsafeTerminalControl(character.codePointAt(0)!) ? '�' : character
      )
      .join('')
    const rawWidth = stringWidth(safeText)
    const text =
      rawWidth > columnLimit ? '�' : rawWidth === 0 ? `◌${safeText}` : safeText
    const segmentWidth = stringWidth(text)
    if (cells > 0 && cells + segmentWidth > columnLimit) pushRow()
    if (segment.highlighted) cursorRow = rows.length - 1
    rows[rows.length - 1]!.push({ text, highlighted: segment.highlighted })
    cells += segmentWidth
  }

  for (const segment of buildPromptCursorSegments(
    value,
    cursorOffset,
    cursorWidth
  ))
  {
    if (
      segment.text === '\n' ||
      segment.text === '\r' ||
      segment.text === '\r\n'
    )
    {
      if (segment.highlighted) append({ text: ' ', highlighted: true })
      pushRow()
    }
    else if (segment.text === '\t')
    {
      const spaces = 4 - (cells % 4)
      for (let index = 0; index < spaces; index += 1)
      {
        append({ text: ' ', highlighted: segment.highlighted && index === 0 })
      }
    }
    else
    {
      append(segment)
    }
  }
  if (cursorOffset === value.length)
  {
    append({ text: ' ', highlighted: true })
  }

  const firstRow = Math.max(
    0,
    Math.min(cursorRow - Math.floor((rowLimit - 1) / 2), rows.length - rowLimit)
  )
  const visible = rows
    .slice(firstRow, firstRow + rowLimit)
    .map((row, index) =>
    {
      // the clip marker belongs on a context row, never over the cursor itself
      if (index === 0 && firstRow > 0 && firstRow !== cursorRow)
      {
        let remaining = columnLimit - 1
        const marked = [{ text: '…', highlighted: false }]
        for (const segment of row)
        {
          const size = stringWidth(segment.text)
          if (size > remaining) break
          marked.push(segment)
          remaining -= size
        }
        row = marked
      }
      return row
        .map((segment) =>
          showCursor && segment.highlighted
            ? chalk.inverse(segment.text)
            : segment.text
        )
        .join('')
    })

  return { rows: visible, cursorRow: cursorRow - firstRow }
}

// callers without terminal geometry keep the existing logical-line estimate
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
  return buildPromptRenderModel(
    value,
    cursorOffset,
    cursorWidth,
    Number.POSITIVE_INFINITY,
    maxRows
  ).rows.join('\n')
}
