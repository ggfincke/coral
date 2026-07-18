// tests/mcp/tool-adapter.test.ts
// protect MCP schema dialect, projection, & validation boundaries

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { JsonSchema } from '../../src/types/inference.js'
import { createMcpTool } from '../../src/mcp/tool-adapter.js'

test('MCP tool adaptation separates raw validation from model projection', () =>
{
  const escape = String.fromCharCode(27)
  const secret = `api-${escape}[31m-key`
  const annotation = `private ${secret} ${'x'.repeat(2_500)}`
  const inputSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      pair: {
        type: 'array',
        items: [{ type: 'string' }, { type: 'number' }],
        additionalItems: false,
      },
      [secret]: { type: 'string', description: annotation },
    },
    required: ['pair', secret],
    additionalProperties: false,
  } as unknown as JsonSchema
  const originalSchema = structuredClone(inputSchema)
  const tool = createMcpTool({
    name: 'mcp__fixture__draft07',
    displayLabel: 'MCP · fixture · draft07',
    description: annotation,
    inputSchema,
    secretValues: [secret],
    invoke: async () => ({ output: 'unused' }),
  })

  const accepted = tool.validateArgs?.({
    pair: ['value', 1],
    [secret]: 'present',
  })
  assert.deepEqual(accepted, {
    ok: true,
    args: { pair: ['value', 1], [secret]: 'present' },
  })

  const tupleRejected = tool.validateArgs?.({
    pair: ['value', 1, 'extra'],
    [secret]: 'present',
  })
  assert.equal(tupleRejected?.ok, false)

  const secretRejected = tool.validateArgs?.({ pair: ['value', 1] })
  assert.equal(secretRejected?.ok, false)
  if (secretRejected?.ok === false)
  {
    assert.match(secretRejected.error, /\[redacted\]/)
    assert.doesNotMatch(secretRejected.error, /api-|31m|-key/)
    assert.equal(secretRejected.error.includes(escape), false)
    assert.ok(secretRejected.error.length < 2_200)
  }

  const projected = JSON.stringify(tool.parameters)
  assert.match(projected, /\[redacted\]/)
  assert.doesNotMatch(projected, /api-|31m|-key/)
  assert.equal(projected.includes(escape), false)
  assert.ok(tool.description.length <= 2_000)
  assert.deepEqual(inputSchema, originalSchema)

  assert.throws(
    () =>
      createMcpTool({
        name: 'mcp__fixture__invalid',
        displayLabel: 'MCP · fixture · invalid',
        inputSchema: {
          type: 'not-a-json-schema-type',
        } as unknown as JsonSchema,
        secretValues: [],
        invoke: async () => ({ output: 'unused' }),
      }),
    /type must be JSONType|schema is invalid/i
  )
})
