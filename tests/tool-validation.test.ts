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

test('coerces a JSON-string object parameter', () =>
{
  const tool: Tool = {
    name: 'opts',
    description: 'object param fixture',
    parameters: {
      type: 'object',
      properties: {
        config: { type: 'object' },
      },
      required: ['config'],
    },
    async execute()
    {
      return { output: '' }
    },
  }

  const result = validateToolArgs(tool, { config: '{"key":"value"}' })
  assert.ok(result.ok)
  if (result.ok)
  {
    assert.deepEqual(result.args.config, { key: 'value' })
  }
})

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

test('caps a long validation problem list & keeps the fix instruction', () =>
{
  const properties: Record<string, { type: string }> = {}
  const required: string[] = []
  for (let i = 1; i <= 12; i++)
  {
    properties[`p${i}`] = { type: 'string' }
    required.push(`p${i}`)
  }
  const wide: Tool = {
    name: 'wide',
    description: 'many required params',
    parameters: { type: 'object', properties, required },
    async execute()
    {
      return { output: '' }
    },
  }

  const result = validateToolArgs(wide, {})
  assert.equal(result.ok, false)
  if (!result.ok)
  {
    // 12 missing-required problems -> first 8 shown, rest summarized
    assert.match(result.error, /plus 4 more/)
    assert.match(result.error, /'p1'/)
    assert.ok(!result.error.includes("'p12'"))
    assert.match(result.error, /Fix the arguments & call the tool again\./)
  }
})
