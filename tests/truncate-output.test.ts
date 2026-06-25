// tests/truncate-output.test.ts
// coverage for newline-delimited output truncation (slice + suffix + edges)

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  truncateOutput,
  type TruncateOutputOptions,
} from '../src/utils/truncate-output.js'

test('returns content unchanged under the limit, dropping blank lines', () =>
{
  assert.equal(truncateOutput('a\nb\nc', 5, 'files'), 'a\nb\nc')
  assert.equal(truncateOutput('a\n\nb', 5, 'files'), 'a\nb')
})

test('returns content unchanged when exactly at the item limit', () =>
{
  assert.equal(truncateOutput('a\nb\nc', 3, 'files'), 'a\nb\nc')
})

test('truncates past the limit with the default Showing-N-of-M suffix', () =>
{
  assert.equal(
    truncateOutput('a\nb\nc\nd', 2, 'matches'),
    'a\nb\n\n(Showing 2 of 4 matches — use a more specific pattern to narrow results)'
  )
})

test('dropEmpty:false counts blank lines as items', () =>
{
  assert.equal(
    truncateOutput('a\n\nb\nc\nd', 3, 'lines', { dropEmpty: false }),
    'a\n\nb\n\n(Showing 3 of 5 lines — use a more specific pattern to narrow results)'
  )
})

test('returns the suffix only when nothing is shown (maxItems 0)', () =>
{
  assert.equal(
    truncateOutput('a\nb', 0, 'files'),
    '(Showing 0 of 2 files — use a more specific pattern to narrow results)'
  )
})

test('honors a custom separator & buildSuffix (restored tool-result shape)', () =>
{
  const options: TruncateOutputOptions = {
    dropEmpty: false,
    separator: '\n',
    buildSuffix: (shown, total) => `… (${total - shown} more lines)`,
  }
  assert.equal(
    truncateOutput('l1\nl2\nl3\nl4', 2, 'lines', options),
    'l1\nl2\n… (2 more lines)'
  )
})
