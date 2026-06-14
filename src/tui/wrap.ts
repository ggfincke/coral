// src/tui/wrap.ts
// shared ANSI-aware line wrapping for TUI renderers

import wrapAnsi from 'wrap-ansi'

// soft-wrap opts (break on spaces, keep leading/trailing space) — shared so the
// transcript tool-result wrapper can't drift from wrapLines
export const SOFT_WRAP_OPTIONS = {
  hard: false,
  trim: false,
  wordWrap: true,
} as const

// wrap text to width while preserving an optional prefix indent
export function wrapLines(text: string, width: number, indent = ''): string[]
{
  const visibleWidth = Math.max(width - indent.length, 12)

  return text.split('\n').flatMap((line) =>
  {
    if (!line) return [indent]

    return wrapAnsi(line, visibleWidth, SOFT_WRAP_OPTIONS)
      .split('\n')
      .map((wrappedLine) => indent + wrappedLine)
  })
}
