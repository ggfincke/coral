// tests/mcp/output.test.ts
// protect fail-closed MCP protocol result conversion

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  formatToolResult,
  type McpOutputValidator,
} from '../../src/mcp/output.js'

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
