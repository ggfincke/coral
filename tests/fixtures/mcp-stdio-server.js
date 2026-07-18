// tests/fixtures/mcp-stdio-server.js
// deterministic stdio MCP server for bridge & lifecycle tests

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const pidPath = process.argv[2]
if (pidPath) await writeFile(pidPath, String(process.pid), 'utf8')
const startupGatePath = process.argv[3] === '-' ? undefined : process.argv[3]
while (startupGatePath && !existsSync(startupGatePath))
{
  await new Promise((resolve) => setTimeout(resolve, 20))
}
const startupDelayMs = Number(process.argv[4] ?? 0)
if (Number.isFinite(startupDelayMs) && startupDelayMs > 0)
{
  await new Promise((resolve) => setTimeout(resolve, startupDelayMs))
}

const stderrToken = process.env.CORAL_MCP_TEST_TOKEN ?? ''
const stderrSplit = stderrToken.indexOf('31m')
if (stderrSplit > 0)
{
  process.stderr.write(stderrToken.slice(0, stderrSplit))
  await new Promise((resolve) => setTimeout(resolve, 20))
  process.stderr.write(`${stderrToken.slice(stderrSplit)}\n`)
}

const server = new McpServer({ name: 'coral-test-server', version: '1.0.0' })

// emit prefixItems & items for draft-2020-12 validation
const pairSchema = z.tuple([z.string(), z.number()]).rest(z.never())

server.registerTool(
  'echo',
  {
    description: `Echo one nested payload. ${process.env.CORAL_MCP_TEST_TOKEN ?? ''}`,
    inputSchema: {
      payload: z
        .object({
          message: z.string().describe(process.env.CORAL_MCP_TEST_TOKEN ?? ''),
          count: z.number().int(),
        })
        .strict(),
      pair: pairSchema,
    },
    outputSchema: {
      echoed: z.string(),
      cwd: z.string(),
      envForwarded: z.boolean(),
      forwardedValue: z.string(),
      pair: pairSchema,
    },
  },
  async ({ payload, pair }) =>
  {
    const echoed = payload.message.repeat(payload.count)
    const structuredContent = {
      echoed,
      cwd: process.cwd(),
      envForwarded:
        process.env.CORAL_MCP_TEST_TOKEN === 'bridge-\x1b[31m-value',
      forwardedValue: process.env.CORAL_MCP_TEST_TOKEN ?? '',
      pair,
    }
    return {
      content: [
        { type: 'text', text: `echo:${echoed}` },
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
        {
          type: 'resource',
          resource: {
            uri: 'fixture://echo/message.txt',
            mimeType: 'text/plain',
            text: 'embedded resource text',
          },
        },
      ],
      structuredContent,
    }
  }
)

server.registerTool(
  'slow',
  {
    description: 'Wait before returning.',
    inputSchema: { delayMs: z.number().int().positive() },
  },
  async ({ delayMs }) =>
  {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return { content: [{ type: 'text', text: 'finished' }] }
  }
)

server.registerTool(
  'hidden',
  {
    description: 'Remain outside the Coral allowlist.',
    inputSchema: {},
  },
  async () => ({ content: [{ type: 'text', text: 'hidden' }] })
)

server.registerTool(
  'wide',
  {
    description: 'Exceed a small session tool-definition budget.',
    inputSchema: Object.fromEntries(
      Array.from({ length: 160 }, (_, index) => [
        `field_${String(index).padStart(3, '0')}_${'w'.repeat(40)}`,
        z.string(),
      ])
    ),
  },
  async () => ({ content: [{ type: 'text', text: 'wide' }] })
)

server.registerTool(
  'large',
  {
    description: 'Return a large text result.',
    inputSchema: {
      size: z
        .number()
        .int()
        .positive()
        .max(20 * 1024 * 1024)
        .optional(),
    },
  },
  async ({ size = 220_000 }) =>
  {
    const token = process.env.CORAL_MCP_TEST_TOKEN ?? ''
    const prefixLength = Math.max(16_384 - Math.floor(token.length / 2), 0)
    const prefix = 'x'.repeat(Math.min(prefixLength, size))
    const remaining = Math.max(size - prefix.length - token.length, 0)
    return {
      content: [
        { type: 'text', text: `${prefix}${token}${'y'.repeat(remaining)}` },
      ],
    }
  }
)

server.registerTool(
  'disconnect',
  {
    description: 'Exit before returning a tool result.',
    inputSchema: {},
  },
  () =>
  {
    setImmediate(() => process.exit(1))
    return new Promise(() =>
    {})
  }
)

await server.connect(new StdioServerTransport())
