// src/tui/prompt/prompt-edit.ts
// apply readline-style edits for Coral's inline prompt

import type { CoralKey } from '../input/terminal-input.js'
import { clamp } from '../../utils/clamp.js'

const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
})

export interface PromptCursorState
{
  cursorOffset: number
  cursorWidth: number
}

export interface PromptEditInput
{
  value: string
  input: string
  key: CoralKey
  cursor: PromptCursorState
}

export interface PromptEditResult extends PromptCursorState
{
  value: string
}

interface WordBoundary
{
  start: number
  end: number
  isWordLike: boolean
}

function clampCursorOffset(offset: number, value: string): number
{
  return clamp(offset, 0, value.length)
}

// single-entry cache of grapheme boundary offsets for the current value —
// arrow/delete keys reuse the cached offsets instead of re-segmenting
let graphemeCache: { value: string; offsets: number[] } | null = null

// ascending grapheme boundary offsets for value: every segment start + the end
function graphemeOffsets(value: string): number[]
{
  if (graphemeCache && graphemeCache.value === value)
    return graphemeCache.offsets
  const offsets: number[] = []
  for (const segment of GRAPHEME_SEGMENTER.segment(value))
    offsets.push(segment.index)
  offsets.push(value.length)
  graphemeCache = { value, offsets }
  return offsets
}

function isGraphemeBoundary(value: string, offset: number): boolean
{
  if (offset <= 0 || offset >= value.length) return true

  const offsets = graphemeOffsets(value)
  let lo = 0
  let hi = offsets.length - 1
  while (lo <= hi)
  {
    const mid = (lo + hi) >> 1
    if (offsets[mid] === offset) return true
    if (offsets[mid] < offset) lo = mid + 1
    else hi = mid - 1
  }

  return false
}

function previousGraphemeOffset(value: string, offset: number): number
{
  const clamped = clamp(offset, 0, value.length)
  if (clamped <= 0) return 0

  // largest offset strictly less than clamped
  const offsets = graphemeOffsets(value)
  let lo = 0
  let hi = offsets.length - 1
  let result = 0
  while (lo <= hi)
  {
    const mid = (lo + hi) >> 1
    if (offsets[mid] < clamped)
    {
      result = offsets[mid]
      lo = mid + 1
    }
    else hi = mid - 1
  }

  return result
}

function nextGraphemeOffset(value: string, offset: number): number
{
  const clamped = clamp(offset, 0, value.length)
  if (clamped >= value.length) return value.length

  // smallest offset strictly greater than clamped
  const offsets = graphemeOffsets(value)
  let lo = 0
  let hi = offsets.length - 1
  let result = value.length
  while (lo <= hi)
  {
    const mid = (lo + hi) >> 1
    if (offsets[mid] > clamped)
    {
      result = offsets[mid]
      hi = mid - 1
    }
    else lo = mid + 1
  }

  return result
}

function getWordBoundaries(value: string): WordBoundary[]
{
  const boundaries: WordBoundary[] = []

  for (const segment of WORD_SEGMENTER.segment(value))
  {
    boundaries.push({
      start: segment.index,
      end: segment.index + segment.segment.length,
      isWordLike: segment.isWordLike ?? false,
    })
  }

  return boundaries
}

function nextWordOffset(value: string, offset: number): number
{
  for (const boundary of getWordBoundaries(value))
  {
    if (boundary.isWordLike && boundary.start > offset)
    {
      return boundary.start
    }
  }

  return value.length
}

function previousWordOffset(value: string, offset: number): number
{
  if (offset <= 0) return 0

  let previousStart: number | null = null

  for (const boundary of getWordBoundaries(value))
  {
    if (!boundary.isWordLike) continue
    if (boundary.start < offset)
    {
      if (offset > boundary.start && offset <= boundary.end)
      {
        return boundary.start
      }

      previousStart = boundary.start
    }
  }

  return previousStart ?? 0
}

function updateCursor(
  value: string,
  cursorOffset: number,
  cursorWidth = 0
): PromptEditResult
{
  return {
    value,
    cursorOffset: clampCursorOffset(cursorOffset, value),
    cursorWidth,
  }
}

function deleteBackward(value: string, cursorOffset: number): PromptEditResult
{
  if (cursorOffset <= 0)
  {
    return updateCursor(value, cursorOffset)
  }

  const previousOffset = previousGraphemeOffset(value, cursorOffset)
  const deleteEnd = isGraphemeBoundary(value, cursorOffset)
    ? cursorOffset
    : nextGraphemeOffset(value, previousOffset)
  return updateCursor(
    value.slice(0, previousOffset) + value.slice(deleteEnd),
    previousOffset
  )
}

function deleteForward(value: string, cursorOffset: number): PromptEditResult
{
  if (cursorOffset >= value.length)
  {
    return updateCursor(value, cursorOffset)
  }

  const startOffset = isGraphemeBoundary(value, cursorOffset)
    ? cursorOffset
    : previousGraphemeOffset(value, cursorOffset)
  const nextOffset = nextGraphemeOffset(value, startOffset)
  return updateCursor(
    value.slice(0, startOffset) + value.slice(nextOffset),
    startOffset
  )
}

function deleteToLineStart(
  value: string,
  cursorOffset: number
): PromptEditResult
{
  return updateCursor(value.slice(cursorOffset), 0)
}

function deleteToLineEnd(
  value: string,
  cursorOffset: number
): PromptEditResult
{
  return updateCursor(value.slice(0, cursorOffset), cursorOffset)
}

function deleteWordBefore(
  value: string,
  cursorOffset: number
): PromptEditResult
{
  const targetOffset = previousWordOffset(value, cursorOffset)
  return updateCursor(
    value.slice(0, targetOffset) + value.slice(cursorOffset),
    targetOffset
  )
}

function deleteWordAfter(
  value: string,
  cursorOffset: number
): PromptEditResult
{
  const targetOffset = nextWordOffset(value, cursorOffset)
  return updateCursor(
    value.slice(0, cursorOffset) + value.slice(targetOffset),
    cursorOffset
  )
}

function insertText(
  value: string,
  cursorOffset: number,
  input: string
): PromptEditResult
{
  const nextValue =
    value.slice(0, cursorOffset) + input + value.slice(cursorOffset)
  return updateCursor(
    nextValue,
    cursorOffset + input.length,
    input.length > 1 ? input.length : 0
  )
}

export function applyPromptEdit({
  value,
  input,
  key,
  cursor,
}: PromptEditInput): PromptEditResult | null
{
  if (key.ctrl && input === 'a')
  {
    return updateCursor(value, 0)
  }
  if (key.ctrl && input === 'e')
  {
    return updateCursor(value, value.length)
  }
  if (key.home)
  {
    return updateCursor(value, 0)
  }
  if (key.end)
  {
    return updateCursor(value, value.length)
  }
  if (key.ctrl && input === 'b')
  {
    return updateCursor(
      value,
      previousGraphemeOffset(value, cursor.cursorOffset)
    )
  }
  if (key.ctrl && input === 'f')
  {
    return updateCursor(value, nextGraphemeOffset(value, cursor.cursorOffset))
  }
  if (key.leftArrow && (key.ctrl || key.meta))
  {
    return updateCursor(value, previousWordOffset(value, cursor.cursorOffset))
  }
  if (key.rightArrow && (key.ctrl || key.meta))
  {
    return updateCursor(value, nextWordOffset(value, cursor.cursorOffset))
  }
  if (key.leftArrow)
  {
    return updateCursor(
      value,
      previousGraphemeOffset(value, cursor.cursorOffset)
    )
  }
  if (key.rightArrow)
  {
    return updateCursor(value, nextGraphemeOffset(value, cursor.cursorOffset))
  }
  if (key.ctrl && input === 'u')
  {
    return deleteToLineStart(value, cursor.cursorOffset)
  }
  if (key.ctrl && input === 'k')
  {
    return deleteToLineEnd(value, cursor.cursorOffset)
  }
  if (key.ctrl && input === 'w')
  {
    return deleteWordBefore(value, cursor.cursorOffset)
  }
  if (key.ctrl && input === 'd')
  {
    return deleteForward(value, cursor.cursorOffset)
  }
  if (key.ctrl && key.delete)
  {
    return deleteToLineEnd(value, cursor.cursorOffset)
  }
  if (key.ctrl && key.backspace)
  {
    return deleteWordBefore(value, cursor.cursorOffset)
  }
  if (key.meta && input === 'd')
  {
    return deleteWordAfter(value, cursor.cursorOffset)
  }
  if (key.meta && key.backspace)
  {
    return deleteWordBefore(value, cursor.cursorOffset)
  }
  if (key.meta && key.delete)
  {
    return deleteToLineEnd(value, cursor.cursorOffset)
  }
  if (key.backspace || (key.ctrl && input === 'h'))
  {
    return deleteBackward(value, cursor.cursorOffset)
  }
  if (key.delete)
  {
    return deleteForward(value, cursor.cursorOffset)
  }
  if (!input)
  {
    return null
  }

  return insertText(value, cursor.cursorOffset, input)
}
