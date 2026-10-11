// src/tui/prompt/prompt-edit.ts
// apply readline-style edits for Coral's inline prompt

import type { CoralKey } from '../input/terminal-input.js'
import { clamp } from '../../utils/clamp.js'
import { buildLineStarts, locateOffset } from './line-index.js'
import {
  isGraphemeBoundary,
  nextGraphemeOffset,
  previousGraphemeOffset,
} from './grapheme.js'

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
  // text removed by a killing operation (ctrl+w/u/k) for kill-ring capture
  killed?: string
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

// kill from the cursor back to its own line's start (multi-line aware)
function deleteToLineStart(
  value: string,
  cursorOffset: number
): PromptEditResult
{
  const starts = buildLineStarts(value)
  const rowStart = starts[locateOffset(starts, cursorOffset).row] ?? 0
  if (cursorOffset <= rowStart)
  {
    return updateCursor(value, cursorOffset)
  }

  return {
    ...updateCursor(
      value.slice(0, rowStart) + value.slice(cursorOffset),
      rowStart
    ),
    killed: value.slice(rowStart, cursorOffset),
  }
}

// kill from the cursor to its own line's end (multi-line aware)
function deleteToLineEnd(
  value: string,
  cursorOffset: number
): PromptEditResult
{
  const starts = buildLineStarts(value)
  const index = locateOffset(starts, cursorOffset).row
  const rowEnd =
    index + 1 < starts.length ? (starts[index + 1] ?? 0) - 1 : value.length
  if (cursorOffset >= rowEnd)
  {
    return updateCursor(value, cursorOffset)
  }

  return {
    ...updateCursor(
      value.slice(0, cursorOffset) + value.slice(rowEnd),
      cursorOffset
    ),
    killed: value.slice(cursorOffset, rowEnd),
  }
}

function deleteWordBefore(
  value: string,
  cursorOffset: number
): PromptEditResult
{
  const targetOffset = previousWordOffset(value, cursorOffset)
  return {
    ...updateCursor(
      value.slice(0, targetOffset) + value.slice(cursorOffset),
      targetOffset
    ),
    killed: value.slice(targetOffset, cursorOffset),
  }
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

// splice arbitrary text at an offset for yank & programmatic inserts
export function insertTextAt(
  value: string,
  cursorOffset: number,
  text: string
): PromptEditResult
{
  return insertText(value, clamp(cursorOffset, 0, value.length), text)
}

// backslash-continuation: a trailing '\' becomes the newline instead of
// submitting; null means the caller should treat Enter as submit
export function continueWithNewline(
  value: string,
  cursorOffset: number
): PromptEditResult | null
{
  if (cursorOffset <= 0 || value[cursorOffset - 1] !== '\\')
  {
    return null
  }

  return updateCursor(
    value.slice(0, cursorOffset - 1) + '\n' + value.slice(cursorOffset),
    cursorOffset
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
  if ((key.ctrl && input === 'j') || (key.meta && key.return))
  {
    // readline binds ctrl+j to newline; meta+enter is the discoverable alias
    return updateCursor(
      value.slice(0, cursor.cursorOffset) +
        '\n' +
        value.slice(cursor.cursorOffset),
      cursor.cursorOffset + 1
    )
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
