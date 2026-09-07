// src/tui/wrap.ts
// shared ANSI-aware line wrapping for TUI renderers

import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'

// visible terminal columns (ANSI-aware and fullwidth-aware, matching wrap-ansi)
export function visibleWidth(text: string): number
{
  return stringWidth(text)
}

// right-pad a possibly ANSI-styled string to a visible width
export function padEnd(value: string, width: number): string
{
  return value + ' '.repeat(Math.max(width - visibleWidth(value), 0))
}

// fit a physical row without cutting ANSI sequences or hiding truncation
export function truncateLine(
  text: string,
  width: number,
  ellipsis = '…'
): string
{
  if (width <= 0) return ''
  if (visibleWidth(text) <= width) return text
  const suffix = visibleWidth(ellipsis) <= width ? ellipsis : ''
  const budget = width - visibleWidth(suffix)
  if (budget <= 0) return suffix
  const first =
    wrapAnsi(text, budget, { hard: true, trim: false, wordWrap: false }).split(
      '\n'
    )[0] ?? ''
  return (visibleWidth(first) <= budget ? first : '') + suffix
}

// center a possibly ANSI-styled line within a visible width
export function center(line: string, width: number): string
{
  const totalPad = Math.max(width - visibleWidth(line), 0)
  const leftPad = Math.floor(totalPad / 2)
  const rightPad = totalPad - leftPad
  return ' '.repeat(leftPad) + line + ' '.repeat(rightPad)
}

// soft-wrap opts (break on spaces, keep leading/trailing space) — shared so the
// keep transcript tool-result wrapping consistent with wrapLines
export const SOFT_WRAP_OPTIONS = {
  hard: false,
  trim: false,
  wordWrap: true,
} as const

// wrap text to width while preserving an optional prefix indent; measured by
// visible width so styled indents do not overstate the available columns
export function wrapLines(text: string, width: number, indent = ''): string[]
{
  const wrapWidth = Math.max(width - visibleWidth(indent), 12)

  return text.split('\n').flatMap((line) =>
  {
    if (!line) return [indent]

    return wrapAnsi(line, wrapWidth, SOFT_WRAP_OPTIONS)
      .split('\n')
      .map((wrappedLine) => indent + wrappedLine)
  })
}

// normalize formatted content before viewport slicing so every row is counted
export function physicalLines(lines: string[], width: number): string[]
{
  return lines.flatMap((line) =>
    wrapAnsi(line, Math.max(width, 1), {
      hard: true,
      trim: false,
      wordWrap: true,
    }).split('\n')
  )
}
