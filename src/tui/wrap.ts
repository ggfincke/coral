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

// wrap text to width while preserving an optional prefix indent
export function wrapLines(text: string, width: number, indent = ''): string[]
{
  const wrapWidth = Math.max(width - indent.length, 12)

  return text.split('\n').flatMap((line) =>
  {
    if (!line) return [indent]

    return wrapAnsi(line, wrapWidth, SOFT_WRAP_OPTIONS)
      .split('\n')
      .map((wrappedLine) => indent + wrappedLine)
  })
}
