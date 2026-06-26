// tests/agent/doom-loop.test.ts
// stuck-loop detection — repeated calls & repeated errors

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DoomLoopDetector,
  describeDoomLoop,
} from '../../src/agent/doom-loop.js'

test('trips on the same call repeated to the threshold', () =>
{
  const d = new DoomLoopDetector()
  assert.equal(d.record('read_file', { path: 'a.ts' }), null)
  assert.equal(d.record('read_file', { path: 'a.ts' }), null)
  const trip = d.record('read_file', { path: 'a.ts' })
  assert.equal(trip?.kind, 'repeat-call')
  assert.equal(trip?.detail, 'read_file')
  assert.equal(trip?.count, 3)
})

test('distinct calls never trip', () =>
{
  const d = new DoomLoopDetector()
  assert.equal(d.record('read_file', { path: 'a.ts' }), null)
  assert.equal(d.record('read_file', { path: 'b.ts' }), null)
  assert.equal(d.record('grep', { pattern: 'x' }), null)
  assert.equal(d.record('read_file', { path: 'c.ts' }), null)
})

test('signature ignores argument key order', () =>
{
  const d = new DoomLoopDetector()
  d.record('edit_file', { path: 'a.ts', old: 'x', new: 'y' })
  d.record('edit_file', { new: 'y', path: 'a.ts', old: 'x' })
  const trip = d.record('edit_file', { old: 'x', new: 'y', path: 'a.ts' })
  assert.equal(trip?.kind, 'repeat-call')
})

test('trips on the same error across different calls', () =>
{
  const d = new DoomLoopDetector()
  const err = 'old_string not found in file'
  assert.equal(d.record('edit_file', { path: 'a.ts' }, err), null)
  assert.equal(d.record('edit_file', { path: 'b.ts' }, err), null)
  const trip = d.record('edit_file', { path: 'c.ts' }, err)
  assert.equal(trip?.kind, 'repeat-error')
  assert.equal(trip?.count, 3)
  assert.ok(trip?.detail.includes('old_string'))
})

test('reset clears the window so a fresh streak is needed', () =>
{
  const d = new DoomLoopDetector()
  d.record('read_file', { path: 'a.ts' })
  d.record('read_file', { path: 'a.ts' })
  d.reset()
  assert.equal(d.record('read_file', { path: 'a.ts' }), null)
  assert.equal(d.record('read_file', { path: 'a.ts' }), null)
  assert.ok(d.record('read_file', { path: 'a.ts' }))
})

test('describeDoomLoop renders a human-readable line', () =>
{
  const call = describeDoomLoop({
    kind: 'repeat-call',
    detail: 'bash',
    count: 3,
  })
  assert.ok(call.includes('bash') && call.includes('3'))

  const error = describeDoomLoop({
    kind: 'repeat-error',
    detail: 'permission denied',
    count: 4,
  })
  assert.ok(error.includes('permission denied') && error.includes('4'))
})
