// tests/tool-output.test.ts
// tests for model-bound tool-output truncation

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  capToolOutput,
  MAX_TOOL_OUTPUT_CHARS,
} from '../src/agent/tool-output.js'

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
