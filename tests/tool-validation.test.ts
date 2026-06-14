// tests/tool-validation.test.ts
// unit tests for pre-dispatch tool arg validation & coercion

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { validateToolArgs } from '../src/agent/tool-validation.js'
import type { Tool } from '../src/tools/index.js'

const fixtureTool: Tool = {
  name: 'fixture',
  description: 'test fixture',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      depth: { type: 'number' },
      all: { type: 'boolean' },
    },
    required: ['path'],
  },
  async execute()
  {
    return { output: '' }
  },
}

test('coerces common weak-model slips & rejects uncoercible types', () =>
{
  const coerced = validateToolArgs(fixtureTool, {
    path: 'a.ts',
    depth: '3',
    all: 'true',
  })
  assert.ok(coerced.ok)
  if (coerced.ok)
  {
    assert.equal(coerced.args.depth, 3)
    assert.equal(coerced.args.all, true)
  }

  const bad = validateToolArgs(fixtureTool, { path: 'a', depth: 'deep' })
  assert.equal(bad.ok, false)
  if (!bad.ok)
  {
    assert.match(bad.error, /parameter 'depth' must be a number/)
  }
})
