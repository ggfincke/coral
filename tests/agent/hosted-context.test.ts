// tests/agent/hosted-context.test.ts
// verify a hosted model keeps hosted behavior when its limits fail to load

import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Agent } from '../../src/agent/agent.js'
import { MIN_NUM_CTX } from '../../src/config/context.js'
import { subagentTools } from '../../src/tools/registry.js'
import { makeAgentEvents } from '../helpers/agent-harness.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

test('a failed hosted lookup fails the turn unpinned, then the retry stays hosted', async () =>
{
  const dir = await tempDir('coral-hosted-context-')
  await writeFile(join(dir, 'package.json'), '{\n  "name": "fixture"\n}\n')
  let lookups = 0
  let streams = 0
  const agent = new Agent('anthropic/claude-x', undefined, dir, {
    tools: subagentTools,
    inferenceClient: {
      startKeepAlive()
      {},
      async showModel()
      {
        lookups++
        if (lookups === 1) throw new Error('keyring lookup timed out')
        return {
          contextLength: 200_000,
          hosted: { maxOutputTokens: 64_000, nativeContextTokens: 200_000 },
        }
      },
      async listModels()
      {
        return []
      },
      async *chatStream()
      {
        streams++
        // hosted JSON in an answer is text, never a tool call
        yield {
          message: {
            role: 'assistant',
            content: '{"name":"read_file","arguments":{"path":"package.json"}}',
          },
          done: true,
        }
      },
    },
  })

  const calls: string[] = []
  const failures: Error[] = []
  const events = makeAgentEvents({
    onToolCall(name)
    {
      calls.push(name)
    },
    onError(error)
    {
      failures.push(error)
    },
  })

  await agent.run('show me the call', events)
  assert.deepEqual(
    failures.map((error) => error.message),
    ['keyring lookup timed out']
  )
  assert.equal(streams, 0)

  await agent.run('show me the call', events)
  assert.equal(failures.length, 1)
  assert.equal(streams, 1)
  assert.deepEqual(calls, [])
  assert.equal(lookups, 2)
  const window = await agent.fetchContextWindow()
  assert.notEqual(window, MIN_NUM_CTX)
  assert.equal(window, 200_000)
})
