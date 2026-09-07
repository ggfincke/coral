// tests/utils/truncate-output.test.ts
// tests for stored-output bounding (head/tail retention)

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { capStoredOutput } from '../../src/utils/truncate-output.js'

test('capStoredOutput keeps text under the limit verbatim', () =>
{
  assert.deepEqual(capStoredOutput('hello'), {
    text: 'hello',
    omittedChars: 0,
  })
  const exact = 'x'.repeat(100_000)
  assert.deepEqual(capStoredOutput(exact), { text: exact, omittedChars: 0 })
})

test('oversized output collapses to head+marker+tail', () =>
{
  const head = 'H'.repeat(60_000)
  const tail = 'T'.repeat(40_000)
  const text = head + 'M'.repeat(7_000) + tail

  const bounded = capStoredOutput(text)
  assert.equal(bounded.omittedChars, 7_000)
  assert.ok(bounded.text.startsWith(head))
  assert.ok(bounded.text.endsWith(tail))
  assert.ok(bounded.text.includes('…[7000 chars not retained]…'))
})
