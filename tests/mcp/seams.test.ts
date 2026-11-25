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
      data: input as Record<string, unknown>,
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
      data: undefined,
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
      return { valid: false, data: undefined, errorMessage: 'must not run' }
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

  test('MCP structured content redacts a secret before truncation can split it', () =>
  {
    const secret = 'structured-secret-value'
    // the first string budget is 80_000 minus object & key overhead, so these offsets straddle it
    for (let offset = 79_960; offset < 80_000; offset++)
    {
      const result = formatToolResult(
        {
          content: [],
          structuredContent: {
            data: `${'a'.repeat(offset)}${secret}${'b'.repeat(1_000)}`,
          },
        },
        undefined,
        [secret]
      )
      assert.doesNotMatch(result.output, /aaaastruct/)
    }
  })
})

describe('MCP tool adapter', () =>
{
  test('MCP schema reconstruction isolates reused IDs and local references', async () =>
  {
    for (const dialect of [
      'http://json-schema.org/draft-07/schema#',
      'https://json-schema.org/draft/2020-12/schema',
    ])
    {
      const schema = (valueType: 'string' | 'integer'): JsonSchema => ({
        $schema: dialect,
        $id: 'https://example.test/tool-contract',
        type: 'object',
        definitions: {
          value: { $id: 'value', type: valueType },
        },
        properties: { value: { $ref: '#/definitions/value' } },
        required: ['value'],
        additionalProperties: false,
      })
      const createTool = () =>
        createMcpTool({
          name: 'mcp__fixture__reconstructed',
          displayLabel: 'MCP · fixture · reconstructed',
          inputSchema: schema('string'),
          outputSchema: schema('integer'),
          secretValues: [],
          invoke: async (args, _signal, bridgeResult) =>
            bridgeResult({ content: [], structuredContent: args }),
        })
      const original = createTool()
      const reconstructed = createTool()

      for (const tool of [original, reconstructed])
      {
        assert.deepEqual(tool.validateArgs?.({ value: 'accepted' }), {
          ok: true,
          args: { value: 'accepted' },
        })
        assert.equal(tool.validateArgs?.({ value: 42 })?.ok, false)

        const acceptedOutput = await tool.execute({ value: 42 })
        assert.equal(acceptedOutput.error, undefined)
        assert.match(acceptedOutput.output, /42/)

        const rejectedOutput = await tool.execute({ value: 'rejected' })
        assert.equal(rejectedOutput.output, '')
        assert.match(
          rejectedOutput.error ?? '',
          /structured output failed validation/
        )
      }
    }
  })

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
        note: { type: 'string', description: annotation, default: secret },
      },
      required: ['pair', 'note'],
      additionalProperties: { type: 'string' },
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
      note: 'present',
    })
    assert.deepEqual(accepted, {
      ok: true,
      args: { pair: ['value', 1], note: 'present' },
    })

    const tupleRejected = tool.validateArgs?.({
      pair: ['value', 1, 'extra'],
      note: 'present',
    })
    assert.equal(tupleRejected?.ok, false)

    const secretRejected = tool.validateArgs?.({
      pair: ['value', 1],
      note: 'present',
      [secret]: 1,
    })
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

    // structural schema text that would need redaction skips the tool instead of diverging
    for (const structural of [
      { properties: { [secret]: { type: 'string' } } },
      { properties: { env: { type: 'string', enum: ['prod', 'dev'] } } },
    ])
    {
      assert.throws(
        () =>
          createMcpTool({
            name: 'mcp__fixture__structural',
            displayLabel: 'MCP · fixture · structural',
            inputSchema: { type: 'object', ...structural } as JsonSchema,
            secretValues: [secret, 'prod'],
            invoke: async () => ({ output: 'unused' }),
          }),
        /outside annotations contains a forwarded environment value/
      )
    }

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

  test('MCP schemas route older dialects to a compiler that accepts tuple items', () =>
  {
    for (const dialect of [
      'http://json-schema.org/draft-04/schema#',
      'http://json-schema.org/draft-06/schema#',
      'https://json-schema.org/draft/2019-09/schema',
    ])
    {
      const tool = createMcpTool({
        name: 'mcp__fixture__tuple',
        displayLabel: 'MCP · fixture · tuple',
        inputSchema: {
          $schema: dialect,
          type: 'object',
          properties: {
            pair: {
              type: 'array',
              items: [{ type: 'string' }, { type: 'number' }],
            },
          },
        } as unknown as JsonSchema,
        secretValues: [],
        invoke: async () => ({ output: 'unused' }),
      })
      assert.equal(tool.validateArgs?.({ pair: ['value', 1] })?.ok, true)
      assert.equal(tool.validateArgs?.({ pair: [1, 'value'] })?.ok, false)
    }
  })

  test('MCP schemas keep tools whose structural text only shares short or dialect values', () =>
  {
    const tool = createMcpTool({
      name: 'mcp__fixture__common',
      displayLabel: 'MCP · fixture · common',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          count: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' },
          pair: { type: 'array', prefixItems: [{ type: 'string' }] },
        },
      } as unknown as JsonSchema,
      secretValues: ['json', '12', '1'],
      invoke: async () => ({ output: 'unused' }),
    })
    const parameters = tool.parameters as Record<string, unknown>
    assert.equal('$schema' in parameters, false)
    assert.match(JSON.stringify(parameters), /\^\[1-9\]\[0-9\]\{0,5\}\$/)
    // the raw $schema still selects 2020-12, so prefixItems is enforced
    assert.equal(tool.validateArgs?.({ count: '7', pair: ['a'] })?.ok, true)
    assert.equal(tool.validateArgs?.({ pair: [1] })?.ok, false)
  })

  test('MCP schemas skip a tool whose enum data holds a forwarded value', () =>
  {
    const secret = 'enum-object-secret'
    assert.throws(
      () =>
        createMcpTool({
          name: 'mcp__fixture__enum',
          displayLabel: 'MCP · fixture · enum',
          inputSchema: {
            type: 'object',
            properties: {
              choice: { enum: [{ description: `use ${secret}` }] },
            },
          } as unknown as JsonSchema,
          secretValues: [secret],
          invoke: async () => ({ output: 'unused' }),
        }),
      /outside annotations contains a forwarded environment value/
    )
  })

  test('MCP schema compilation keeps unknown-format warnings off the console', (context) =>
  {
    const warn = context.mock.method(console, 'warn', () => undefined)
    createMcpTool({
      name: 'mcp__fixture__format',
      displayLabel: 'MCP · fixture · format',
      inputSchema: {
        type: 'object',
        properties: { file: { type: 'string', format: 'path' } },
      } as JsonSchema,
      secretValues: [],
      invoke: async () => ({ output: 'unused' }),
    })
    assert.equal(warn.mock.callCount(), 0)
  })
})
