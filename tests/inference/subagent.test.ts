// tests/inference/subagent.test.ts
// read-only subagents inherit the injected inference client

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { makeAgentEvents, makeFakeAgent } from '../helpers/agent-harness.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

test('createReadOnlySubagent forwards this.client instead of constructing OllamaClient', async () =>
{
  const dir = await tempDir('coral-subagent-client-')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
  {
    throw new Error('subagent must not construct OllamaClient')
  }

  try
  {
    const { agent, streams } = makeFakeAgent(
      dir,
      [
        [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'task',
                    arguments: { prompt: 'inspect the project' },
                  },
                },
              ],
            },
            done: true,
          },
        ],
        [
          {
            message: { role: 'assistant', content: 'subagent report' },
            done: true,
          },
        ],
        [{ message: { role: 'assistant', content: 'done' }, done: true }],
      ],
      {
        numCtx: 8_192,
      }
    )

    await agent.run('delegate the inspection', makeAgentEvents())
    assert.equal(streams(), 3)
    await agent.dispose()
  }
  finally
  {
    globalThis.fetch = originalFetch
  }
})
