// tests/tui/editor-history.test.ts
// tests for prompt editor undo coalescing & kill-ring memory

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  EMPTY_EDITOR_MEMORY,
  nextKillIndex,
  popUndo,
  pushKill,
  pushUndo,
} from '../../src/tui/prompt/editor-history.js'

test('pushUndo coalesces consecutive char inserts into one unit', () =>
{
  let memory = EMPTY_EDITOR_MEMORY

  memory = pushUndo(memory, { value: '', cursorOffset: 0 }, 'char-insert')
  assert.equal(memory.undoStack.length, 1)
  // a second char insert collapses: still the single pre-typing snapshot
  memory = pushUndo(memory, { value: 'a', cursorOffset: 1 }, 'char-insert')
  assert.equal(memory.undoStack.length, 1)

  // any other op breaks the run
  memory = pushUndo(memory, { value: 'ab', cursorOffset: 2 }, 'other')
  assert.equal(memory.undoStack.length, 2)

  // and a fresh typing run starts its own unit
  memory = pushUndo(memory, { value: 'ab x', cursorOffset: 4 }, 'char-insert')
  assert.equal(memory.undoStack.length, 3)
})

test('popUndo restores past states & resets coalescing', () =>
{
  let memory = EMPTY_EDITOR_MEMORY
  memory = pushUndo(memory, { value: '', cursorOffset: 0 }, 'char-insert')
  memory = pushUndo(memory, { value: 'abc', cursorOffset: 3 }, 'other')

  const first = popUndo(memory, { value: 'abcd', cursorOffset: 4 })
  assert.equal(first.restore?.value, 'abc')
  assert.equal(first.memory.lastOpCharInsert, false)
  assert.equal(first.memory.undoStack.length, 1)

  const second = popUndo(first.memory, { value: 'abc', cursorOffset: 3 })
  assert.equal(second.restore?.value, '')
})

test('popUndo on an empty stack is a no-op', () =>
{
  const result = popUndo(EMPTY_EDITOR_MEMORY, {
    value: 'draft',
    cursorOffset: 5,
  })
  assert.deepEqual(result.restore, { value: 'draft', cursorOffset: 5 })
})

test('undo depth is bounded', () =>
{
  let memory = EMPTY_EDITOR_MEMORY
  for (let i = 0; i < 250; i += 1)
  {
    memory = pushUndo(
      memory,
      { value: String(i), cursorOffset: 0 },
      i % 2 === 0 ? 'char-insert' : 'other'
    )
  }
  assert.equal(memory.undoStack.length <= 100, true)
})

test('pushKill keeps newest-first order, dedupes, caps entries', () =>
{
  let ring: readonly string[] = []
  ring = pushKill(ring, 'first')
  ring = pushKill(ring, 'second')
  assert.deepEqual(ring, ['second', 'first'])

  // re-killing identical text promotes it instead of duplicating
  ring = pushKill(ring, 'first')
  assert.deepEqual(ring, ['first', 'second'])

  // empty kills never enter
  assert.equal(pushKill(ring, ''), ring)

  for (let i = 0; i < 15; i += 1)
  {
    ring = pushKill(ring, `kill-${i}`)
  }
  assert.ok(ring.length <= 10)
  assert.equal(ring[0], 'kill-14')
})

test('nextKillIndex wraps through the ring', () =>
{
  assert.equal(nextKillIndex(3, 0), 1)
  assert.equal(nextKillIndex(3, 2), 0)
  assert.equal(nextKillIndex(0, 0), 0)
})
