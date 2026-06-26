// src/tui/prompt/prompt-render.ts
// prompt cursor rendering helpers

import chalk from 'chalk'

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
})

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

export function renderPromptValueWithCursor(
  value: string,
  cursorOffset: number,
  cursorWidth: number
): string
{
  if (value.length === 0) return chalk.inverse(' ')

  let rendered = ''
  for (const segment of buildPromptCursorSegments(
    value,
    cursorOffset,
    cursorWidth
  ))
  {
    rendered += segment.highlighted ? chalk.inverse(segment.text) : segment.text
  }

  if (cursorOffset === value.length)
  {
    rendered += chalk.inverse(' ')
  }

  return rendered
}
