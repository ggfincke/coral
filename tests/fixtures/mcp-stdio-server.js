// tests/fixtures/mcp-stdio-server.js
// deterministic stdio MCP server for bridge & lifecycle tests

import { writeFile } from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const pidPath = process.argv[2]
if (pidPath) await writeFile(pidPath, String(process.pid), 'utf8')

const stderrToken = process.env.CORAL_MCP_TEST_TOKEN ?? ''
const stderrSplit = stderrToken.indexOf('31m')
if (stderrSplit > 0)
{
  process.stderr.write(stderrToken.slice(0, stderrSplit))
  await new Promise((resolve) => setTimeout(resolve, 20))
  process.stderr.write(`${stderrToken.slice(stderrSplit)}\n`)
}

const server = new McpServer({ name: 'coral-test-server', version: '1.0.0' })

// emits prefixItems + items, valid only under draft-2020-12 semantics (F1)
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

await server.connect(new StdioServerTransport())
