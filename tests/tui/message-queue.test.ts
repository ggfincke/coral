// tests/tui/message-queue.test.ts
// tests for the queued-messages FIFO logic

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  dequeueOldestMessage,
  editQueuedMessage,
  emptyMessageQueue,
  enqueueMessage,
  formatQueueLines,
  MAX_QUEUED_MESSAGES,
  promoteNewestForEdit,
} from '../../src/tui/run/message-queue.js'

test('enqueue keeps insertion order & assigns monotonic ids', () =>
{
  let state = emptyMessageQueue()
  state = enqueueMessage(state, 'first')
  state = enqueueMessage(state, '  second  ')

  assert.deepEqual(
    state.entries.map((entry) => entry.text),
    ['first', 'second']
  )
  assert.deepEqual(
    state.entries.map((entry) => entry.id),
    [1, 2]
  )
})

test('enqueue ignores blanks & stops at the cap', () =>
{
  let state = emptyMessageQueue()
  assert.equal(enqueueMessage(state, '   '), state)

  for (let i = 0; i < MAX_QUEUED_MESSAGES + 5; i += 1)
  {
    state = enqueueMessage(state, `msg-${i}`)
  }
  assert.equal(state.entries.length, MAX_QUEUED_MESSAGES)
  // oldest survive: the cap rejects newest rather than silently dropping
  // history the user believes was queued
  assert.equal(state.entries[0]?.text, 'msg-0')
})

test('dequeue pops oldest first & leaves later ids untouched', () =>
{
  let state = emptyMessageQueue()
  state = enqueueMessage(state, 'one')
  state = enqueueMessage(state, 'two')

  const first = dequeueOldestMessage(state)
  assert.equal(first?.message.text, 'one')
  assert.deepEqual(
    first?.state.entries.map((e) => e.text),
    ['two']
  )

  const empty = dequeueOldestMessage(emptyMessageQueue())
  assert.equal(empty, null)
})

test('promote takes the NEWEST entry for composer editing', () =>
{
  let state = emptyMessageQueue()
  state = enqueueMessage(state, 'old')
  state = enqueueMessage(state, 'new')

  const promoted = promoteNewestForEdit(state)
  assert.equal(promoted?.message.text, 'new')
  assert.deepEqual(
    promoted?.state.entries.map((e) => e.text),
    ['old']
  )
})

test('edit updates text; editing to blank removes the entry', () =>
{
  let state = emptyMessageQueue()
  state = enqueueMessage(state, 'draft one')
  state = enqueueMessage(state, 'draft two')

  state = editQueuedMessage(state, 2, 'rewritten')
  assert.equal(state.entries[1]?.text, 'rewritten')

  state = editQueuedMessage(state, 1, '   ')
  assert.deepEqual(
    state.entries.map((e) => e.id),
    [2]
  )
})

test('formatQueueLines collapses whitespace & truncates long entries', () =>
{
  const lines = formatQueueLines([
    { id: 4, text: 'multi\nline\ttext' },
    { id: 5, text: 'x'.repeat(200) },
  ])

  assert.equal(lines[0], 'queued #4: multi line text')
  assert.ok(lines[1]!.length <= 'queued #5: '.length + 120)
  assert.ok(lines[1]?.endsWith('…'))
})
