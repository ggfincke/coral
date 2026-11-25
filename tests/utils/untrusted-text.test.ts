// tests/utils/untrusted-text.test.ts
// untrusted-text sanitizer stays linear on unterminated OSC starts

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { sanitizeUntrustedText } from '../../src/utils/untrusted-text.js'

test('unterminated OSC starts sanitize in linear time', () =>
{
  const hostile = '\x1b]'.repeat(50_000)
  const started = performance.now()
  const sanitized = sanitizeUntrustedText(hostile)
  const elapsed = performance.now() - started
  // the regex path took over a second here; linear scanning takes a few ms
  assert.ok(elapsed < 250, `took ${elapsed.toFixed(1)} ms`)
  assert.equal(sanitized, ']'.repeat(50_000))
  assert.equal(sanitizeUntrustedText('a\x1b]0;title\x07b\x1b[31mc'), 'abc')
})
