// tests/prompt-edit.test.ts
// regression tests for readline-style prompt editing

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

test('applyPromptEdit supports ctrl+a/e line navigation', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'hello world',
      input: 'a',
      key: buildKey({ ctrl: true }),
      cursor: buildCursor(5),
    }),
    {
      value: 'hello world',
      cursorOffset: 0,
      cursorWidth: 0,
    }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'hello world',
      input: 'e',
      key: buildKey({ ctrl: true }),
      cursor: buildCursor(5),
    }),
    {
      value: 'hello world',
      cursorOffset: 11,
      cursorWidth: 0,
    }
  )
})

test('applyPromptEdit supports home/end keys', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'hello world',
      input: '',
      key: buildKey({ home: true }),
      cursor: buildCursor(7),
    }),
    {
      value: 'hello world',
      cursorOffset: 0,
      cursorWidth: 0,
    }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'hello world',
      input: '',
      key: buildKey({ end: true }),
      cursor: buildCursor(2),
    }),
    {
      value: 'hello world',
      cursorOffset: 11,
      cursorWidth: 0,
    }
  )
})

test('applyPromptEdit supports ctrl+b/f char navigation', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'hello',
      input: 'b',
      key: buildKey({ ctrl: true }),
      cursor: buildCursor(3),
    }),
    {
      value: 'hello',
      cursorOffset: 2,
      cursorWidth: 0,
    }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'hello',
      input: 'f',
      key: buildKey({ ctrl: true }),
      cursor: buildCursor(3),
    }),
    {
      value: 'hello',
      cursorOffset: 4,
      cursorWidth: 0,
    }
  )
})

test('applyPromptEdit supports ctrl/meta word navigation', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'hello brave world',
      input: '',
      key: buildKey({ leftArrow: true, meta: true }),
      cursor: buildCursor(17),
    }),
    {
      value: 'hello brave world',
      cursorOffset: 12,
      cursorWidth: 0,
    }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'hello brave world',
      input: '',
      key: buildKey({ rightArrow: true, ctrl: true }),
      cursor: buildCursor(0),
    }),
    {
      value: 'hello brave world',
      cursorOffset: 6,
      cursorWidth: 0,
    }
  )
})

test('applyPromptEdit supports Mac Delete & Fn+Delete', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'hello',
      input: '',
      key: buildKey({ backspace: true }),
      cursor: buildCursor(3),
    }),
    {
      value: 'helo',
      cursorOffset: 2,
      cursorWidth: 0,
    }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'hello',
      input: '',
      key: buildKey({ delete: true }),
      cursor: buildCursor(2),
    }),
    {
      value: 'helo',
      cursorOffset: 2,
      cursorWidth: 0,
    }
  )
})

test('applyPromptEdit supports ctrl+d forward delete', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'hello',
      input: 'd',
      key: buildKey({ ctrl: true }),
      cursor: buildCursor(1),
    }),
    {
      value: 'hllo',
      cursorOffset: 1,
      cursorWidth: 0,
    }
  )
})

test('applyPromptEdit supports ctrl+u/k line kills', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'hello world',
      input: 'u',
      key: buildKey({ ctrl: true }),
      cursor: buildCursor(6),
    }),
    {
      value: 'world',
      cursorOffset: 0,
      cursorWidth: 0,
    }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'hello world',
      input: 'k',
      key: buildKey({ ctrl: true }),
      cursor: buildCursor(6),
    }),
    {
      value: 'hello ',
      cursorOffset: 6,
      cursorWidth: 0,
    }
  )
})

test('applyPromptEdit supports ctrl+w & option-delete backward word kills', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'hello brave world',
      input: 'w',
      key: buildKey({ ctrl: true }),
      cursor: buildCursor(17),
    }),
    {
      value: 'hello brave ',
      cursorOffset: 12,
      cursorWidth: 0,
    }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'hello brave world',
      input: '',
      key: buildKey({ meta: true, backspace: true }),
      cursor: buildCursor(11),
    }),
    {
      value: 'hello  world',
      cursorOffset: 6,
      cursorWidth: 0,
    }
  )
})

test('applyPromptEdit supports Option+D word delete & line-end kills', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'hello brave world',
      input: 'd',
      key: buildKey({ meta: true }),
      cursor: buildCursor(6),
    }),
    {
      value: 'hello world',
      cursorOffset: 6,
      cursorWidth: 0,
    }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'hello brave world',
      input: '',
      key: buildKey({ meta: true, delete: true }),
      cursor: buildCursor(6),
    }),
    {
      value: 'hello ',
      cursorOffset: 6,
      cursorWidth: 0,
    }
  )

  assert.deepEqual(
    applyPromptEdit({
      value: 'hello brave world',
      input: '',
      key: buildKey({ ctrl: true, delete: true }),
      cursor: buildCursor(6),
    }),
    {
      value: 'hello ',
      cursorOffset: 6,
      cursorWidth: 0,
    }
  )
})

test('applyPromptEdit inserts text & tracks multi-char cursor width', () =>
{
  assert.deepEqual(
    applyPromptEdit({
      value: 'hello',
      input: '!!',
      key: buildKey(),
      cursor: buildCursor(5),
    }),
    {
      value: 'hello!!',
      cursorOffset: 7,
      cursorWidth: 2,
    }
  )
})
