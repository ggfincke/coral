// tests/agent/doom-loop-outcome.test.ts
// a doom-loop callback failure fails the turn instead of reading as a stop

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { makeTempDirPool } from '../helpers/temp.js'
import { makeAgentEvents, makeFakeAgent } from '../helpers/agent-harness.js'

const { tempDir } = makeTempDirPool()

test('a rejecting onDoomLoop settles the turn as failed', async () =>
{
  const dir = await tempDir('coral-doom-outcome-')
  const { agent } = makeFakeAgent(dir, [
    [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              type: 'function',
              function: { name: 'read_file', arguments: { path: 'gone.txt' } },
            },
          ],
        },
        done: true,
      },
    ],
  ])

  let error: Error | undefined
  const outcome = await agent.run(
    'read gone.txt',
    makeAgentEvents({
      async onDoomLoop()
      {
        throw new Error('host prompt crashed')
      },
      onError(value)
      {
        error = value
      },
    })
  )

  assert.equal(outcome.status, 'failed')
  assert.match(error!.message, /host prompt crashed/)
  await agent.dispose()
})
