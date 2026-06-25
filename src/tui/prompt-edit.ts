// src/tui/prompt-edit.ts
// apply readline-style edits for Coral's inline prompt

import type { CoralKey } from './use-coral-input.js'
import { clamp } from '../utils/clamp.js'

const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })

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

  return updateCursor(
    value.slice(0, cursorOffset - 1) + value.slice(cursorOffset),
    cursorOffset - 1
  )
}

function deleteForward(value: string, cursorOffset: number): PromptEditResult
{
  if (cursorOffset >= value.length)
  {
    return updateCursor(value, cursorOffset)
  }

  return updateCursor(
    value.slice(0, cursorOffset) + value.slice(cursorOffset + 1),
    cursorOffset
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
    return updateCursor(value, cursor.cursorOffset - 1)
  }
  if (key.ctrl && input === 'f')
  {
    return updateCursor(value, cursor.cursorOffset + 1)
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
    return updateCursor(value, cursor.cursorOffset - 1)
  }
  if (key.rightArrow)
  {
    return updateCursor(value, cursor.cursorOffset + 1)
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
