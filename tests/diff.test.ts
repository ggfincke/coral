// tests/diff.test.ts
// unit test for unified diff generation

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { computeDiff } from '../src/utils/diff.js'

test('generates unified diffs for the major shapes', () =>
{
  // simple edit: hunk header + change w/ 3 lines of context
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\n'
  const edited = computeDiff(before, before.replace('d', 'D'))
  assert.ok(edited)
  assert.match(edited, /^@@ -1,7 \+1,7 @@/)
  assert.match(edited, /\n-d\n\+D\n/)
  // 3 context lines on each side of the change
  assert.match(edited, /\n a\n b\n c\n-d/)
  assert.match(edited, /\+D\n e\n f\n g$/)

  // new file: all additions
  const created = computeDiff('', 'hello\nworld\n')
  assert.ok(created)
  const signs = created
    .split('\n')
    .filter((line) => !line.startsWith('@@'))
    .map((line) => line[0])
  assert.ok(signs.every((sign) => sign === '+'))

  // nothing displayable -> null
  assert.equal(computeDiff('same\n', 'same\n'), null)
  assert.equal(computeDiff('a\0b', 'a\0c'), null)

  // oversized changes collapse into a summary marker
  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  const truncated = computeDiff('', big)
  assert.ok(truncated)
  assert.ok(truncated.split('\n').length < 250)
  assert.match(truncated, /… \+\d+ more changed lines$/)
})
