// src/tui/wrap.ts
// shared ANSI-aware line wrapping for TUI renderers

import wrapAnsi from 'wrap-ansi'

// wrap text to width while preserving an optional prefix indent
export function wrapLines(text: string, width: number, indent = ''): string[]
{
  const visibleWidth = Math.max(width - indent.length, 12)

  return text.split('\n').flatMap((line) =>
  {
    if (!line) return [indent]

    return wrapAnsi(line, visibleWidth, {
      hard: false,
      trim: false,
      wordWrap: true,
    })
      .split('\n')
      .map((wrappedLine) => indent + wrappedLine)
  })
}
