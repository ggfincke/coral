// tests/tool-output.test.ts
// regression tests for the model-bound tool-output cap

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  capToolOutput,
  MAX_TOOL_OUTPUT_CHARS,
} from '../src/agent/tool-output.js'

test('capToolOutput passes short output through unchanged', () =>
{
  const output = 'a small diff\nwith two lines'
  assert.equal(capToolOutput(output), output)
})

test('capToolOutput truncates oversized output & marks the omission', () =>
{
  const line = 'x'.repeat(99) + '\n'
  const output = line.repeat(2000)
  const capped = capToolOutput(output)

  assert.ok(capped.length < output.length)
  assert.ok(capped.length <= MAX_TOOL_OUTPUT_CHARS + 200)
  assert.match(capped, /output truncated/)
  assert.match(capped, new RegExp(`of ${output.length} chars omitted`))
})

test('capToolOutput cuts back to a line boundary', () =>
{
  // 51-char lines so the cut at MAX_TOOL_OUTPUT_CHARS lands mid-line
  const output = ('z'.repeat(50) + '\n').repeat(3000)
  const capped = capToolOutput(output)
  const body = capped.split('\n\n[output truncated')[0]!

  // every kept line is a whole 50-char line — no partial line at the cut
  assert.ok(body.length > 0)
  assert.ok(body.split('\n').every((l) => l === 'z'.repeat(50)))
})
