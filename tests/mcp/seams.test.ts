// tests/mcp/seams.test.ts
// causal seams for MCP protocol conversion and tool adaptation

import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  formatToolResult,
  type McpOutputValidator,
} from '../../src/mcp/output.js'
import type { JsonSchema } from '../../src/types/inference.js'
import { createMcpTool } from '../../src/mcp/tool-adapter.js'

describe('MCP output conversion', () =>
{
  test('MCP result conversion fails closed without leaking server output', () =>
  {
    const escape = String.fromCharCode(27)
    assert.deepEqual(formatToolResult(null, undefined, []), {
      output: '',
      error: 'MCP server returned an unsupported legacy tool result',
    })

    const validOutput: McpOutputValidator = (input) => ({
      valid: true,
      data: input,
      errorMessage: undefined,
    })
    assert.deepEqual(formatToolResult({ content: [] }, validOutput, []), {
      output: '',
      error:
        'MCP tool declared an output schema but returned no structured content',
    })

    const secret = 'secret-\x1b[31m-token'
    const invalidOutput: McpOutputValidator = () => ({
      valid: false,
      errorMessage: `invalid ${secret} ${'x'.repeat(4_000)}`,
    })
    const invalid = formatToolResult(
      {
        content: [{ type: 'text', text: `untrusted ${secret}` }],
        structuredContent: { accepted: false },
      },
      invalidOutput,
      [secret]
    )
    assert.equal(invalid.output, '')
    assert.match(invalid.error ?? '', /structured output failed validation/)
    assert.match(invalid.error ?? '', /\[redacted\]/)
    assert.doesNotMatch(invalid.error ?? '', /secret|31m|token/)
    assert.equal((invalid.error ?? '').includes(escape), false)
    assert.ok((invalid.error?.length ?? Infinity) < 2_100)

    let serverErrorValidations = 0
    const skippedOutput: McpOutputValidator = () =>
    {
      serverErrorValidations += 1
      return { valid: false, errorMessage: 'must not run' }
    }
    const serverError = formatToolResult(
      {
        content: [{ type: 'text', text: `server ${secret} \x1b[32mfailed` }],
        structuredContent: { accepted: false },
        isError: true,
      },
      skippedOutput,
      [secret]
    )
    assert.equal(serverErrorValidations, 0)
    assert.match(serverError.output, /server \[redacted\] failed/)
    assert.match(serverError.error ?? '', /server reported a tool error/)
    const serverErrorText = `${serverError.output}\n${serverError.error ?? ''}`
    assert.doesNotMatch(serverErrorText, /secret|31m|32m|token/)
    assert.equal(serverErrorText.includes(escape), false)
  })
})

describe('MCP tool adapter', () =>
{
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
})
