// tests/agent/mcp-admission-budget.test.ts
// an MCP catalog that alone overflows the turn names MCP in the error

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseMcpConfig } from '../../src/config/mcp.js'
import type { Tool } from '../../src/tools/tool.js'
import { makeAgentEvents, makeFakeAgent } from '../helpers/agent-harness.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

const mcpConfig = parseMcpConfig({
  servers: {
    demo: {
      command: process.execPath,
      enabledTools: ['ping'],
      yoloTools: ['ping'],
    },
  },
})

const done = [
  [{ message: { role: 'assistant' as const, content: 'ok' }, done: true }],
]

test('MCP schemas that cannot fit with the first turn are named as the cause', async () =>
{
  const dir = await tempDir('coral-mcp-admission-')
  // measure the request w/o MCP to size a turn that fits only w/o the schemas
  const probe = makeFakeAgent(dir, done, { numCtx: 8_192 }).agent
  await probe.run('probe', makeAgentEvents())
  const budget = probe.getLastRequestBudget()!
  const spareTokens = budget.promptLimit - budget.promptTokens
  await probe.dispose()

  const bigTool: Tool = {
    name: 'mcp__demo__ping',
    description: 'x'.repeat(spareTokens * 4),
    parameters: { type: 'object', properties: {} },
    async execute()
    {
      return { output: 'pong' }
    },
  }
  const { agent } = makeFakeAgent(dir, done, {
    numCtx: 8_192,
    mcpMode: 'ask',
    mcpConfig,
    mcpManagerFactory: async () => ({
      async initialize()
      {
        return [bigTool]
      },
      getStatus: () => ({ mode: 'ask', configIssues: [], servers: [] }),
      async dispose()
      {},
    }),
  })

  const errors: Error[] = []
  await agent.run(
    `probe ${'y'.repeat(Math.floor(spareTokens / 2) * 4)}`,
    makeAgentEvents({ onError: (error) => errors.push(error) })
  )

  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /the 1 MCP tool schema \(~\d+ tokens\)/)
  await agent.dispose()
})
