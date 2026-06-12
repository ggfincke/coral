// tests/prompt-edit.test.ts
// tests for major readline-style prompt editing paths

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  applyPromptEdit,
  type PromptCursorState,
} from '../src/tui/prompt-edit.js'
import { buildKey } from '../src/tui/use-coral-input.js'

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
