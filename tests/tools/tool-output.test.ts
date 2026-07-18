// tests/tools/tool-output.test.ts
// tests for model-bound and item-count tool-output truncation

import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { capToolOutput, capErrorMessage } from '../../src/tools/tool-output.js'
import {
  MAX_TOOL_OUTPUT_CHARS,
  MAX_ERROR_MESSAGE_CHARS,
} from '../../src/utils/limits.js'
import {
  truncateOutput,
  type TruncateOutputOptions,
} from '../../src/utils/truncate-output.js'

describe('capToolOutput / capErrorMessage', () =>
{
  test('capToolOutput truncates oversized output and marks the omission', () =>
  {
    const output = ('z'.repeat(50) + '\n').repeat(3000)
    const capped = capToolOutput(output)
    const body = capped.split('\n\n[output truncated')[0]!

    assert.ok(capped.length < output.length)
    assert.ok(capped.length <= MAX_TOOL_OUTPUT_CHARS + 200)
    assert.match(capped, /output truncated/)
    assert.ok(body.split('\n').every((line) => line === 'z'.repeat(50)))
  })

  test('capErrorMessage truncates oversized errors but passes short ones through', () =>
  {
    const short = 'Tool execution failed for read_file: ENOENT'
    assert.equal(capErrorMessage(short), short)

    const huge = 'x'.repeat(MAX_ERROR_MESSAGE_CHARS * 2)
    const capped = capErrorMessage(huge)
    assert.ok(capped.length < huge.length)
    assert.ok(capped.length <= MAX_ERROR_MESSAGE_CHARS + 100)
    assert.match(capped, /error truncated/)
  })
})

describe('truncateOutput', () =>
{
  test('truncates past the limit with the default Showing-N-of-M suffix', () =>
  {
    assert.equal(truncateOutput('a\nb\nc', 5, 'files'), 'a\nb\nc')
    assert.equal(truncateOutput('a\n\nb', 5, 'files'), 'a\nb')
    assert.equal(
      truncateOutput('a\nb\nc\nd', 2, 'matches'),
      'a\nb\n\n(Showing 2 of 4 matches — use a more specific pattern to narrow results)'
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
})
