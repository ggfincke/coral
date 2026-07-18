// tests/tui/prompt-edit.test.ts
// tests for major readline-style prompt editing paths

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  applyPromptEdit,
  type PromptCursorState,
} from '../../src/tui/prompt/prompt-edit.js'
import { buildPromptCursorSegments } from '../../src/tui/prompt/prompt-render.js'
import { buildKey } from '../../src/tui/input/terminal-input.js'

function buildCursor(cursorOffset: number, cursorWidth = 0): PromptCursorState
{
  return { cursorOffset, cursorWidth }
}

test('applyPromptEdit handles line movement, word deletion, and insertion', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'hello brave world',
      input: 'a',
      key: buildKey({ ctrl: true }),
      cursor: buildCursor(17),
    }),
    { value: 'hello brave world', cursorOffset: 0, cursorWidth: 0 }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'hello brave world',
      input: '',
      key: buildKey({ meta: true, backspace: true }),
      cursor: buildCursor(11),
    }),
    { value: 'hello  world', cursorOffset: 6, cursorWidth: 0 }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'hello',
      input: '!!',
      key: buildKey(),
      cursor: buildCursor(5),
    }),
    { value: 'hello!!', cursorOffset: 7, cursorWidth: 2 }
  )
})

test('applyPromptEdit handles backward and forward deletion around the cursor', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'hello',
      input: '',
      key: buildKey({ backspace: true }),
      cursor: buildCursor(3),
    }),
    { value: 'helo', cursorOffset: 2, cursorWidth: 0 }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'hello',
      input: '',
      key: buildKey({ delete: true }),
      cursor: buildCursor(2),
    }),
    { value: 'helo', cursorOffset: 2, cursorWidth: 0 }
  )
})

test('applyPromptEdit keeps grapheme clusters intact', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'a🙂b',
      input: '',
      key: buildKey({ backspace: true }),
      cursor: buildCursor(3),
    }),
    { value: 'ab', cursorOffset: 1, cursorWidth: 0 }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'a🙂b',
      input: '',
      key: buildKey({ delete: true }),
      cursor: buildCursor(1),
    }),
    { value: 'ab', cursorOffset: 1, cursorWidth: 0 }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'cafe\u0301',
      input: '',
      key: buildKey({ backspace: true }),
      cursor: buildCursor('cafe\u0301'.length),
    }),
    { value: 'caf', cursorOffset: 3, cursorWidth: 0 }
  )
})

test('applyPromptEdit moves the cursor across grapheme clusters whole', () =>
{
  // leftArrow from the right side jumps the whole emoji cluster (3 -> 1)
  assert.deepEqual(
    applyPromptEdit({
      value: 'a\ud83d\ude42b',
      input: '',
      key: buildKey({ leftArrow: true }),
      cursor: buildCursor(3),
    }),
    { value: 'a\ud83d\ude42b', cursorOffset: 1, cursorWidth: 0 }
  )

  // rightArrow over the emoji lands on the far cluster boundary (1 -> 3)
  assert.deepEqual(
    applyPromptEdit({
      value: 'a\ud83d\ude42b',
      input: '',
      key: buildKey({ rightArrow: true }),
      cursor: buildCursor(1),
    }),
    { value: 'a\ud83d\ude42b', cursorOffset: 3, cursorWidth: 0 }
  )

  // leftArrow jumps the whole 'e + combining acute' cluster (4 -> 3)
  assert.deepEqual(
    applyPromptEdit({
      value: 'cafe\u0301',
      input: '',
      key: buildKey({ leftArrow: true }),
      cursor: buildCursor('cafe\u0301'.length),
    }),
    { value: 'cafe\u0301', cursorOffset: 3, cursorWidth: 0 }
  )

  // rightArrow over the combining-mark cluster lands past the mark (3 -> 5)
  assert.deepEqual(
    applyPromptEdit({
      value: 'cafe\u0301',
      input: '',
      key: buildKey({ rightArrow: true }),
      cursor: buildCursor(3),
    }),
    { value: 'cafe\u0301', cursorOffset: 'cafe\u0301'.length, cursorWidth: 0 }
  )
})

test('buildPromptCursorSegments compares cursor offsets as UTF-16 boundaries', () =>
{
  assert.deepEqual(buildPromptCursorSegments('a🙂b', 3, 0), [
    { text: 'a', highlighted: false },
    { text: '🙂', highlighted: false },
    { text: 'b', highlighted: true },
  ])

  assert.deepEqual(buildPromptCursorSegments('cafe\u0301', 3, 0), [
    { text: 'c', highlighted: false },
    { text: 'a', highlighted: false },
    { text: 'f', highlighted: false },
    { text: 'e\u0301', highlighted: true },
  ])
})
