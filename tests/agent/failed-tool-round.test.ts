// tests/agent/failed-tool-round.test.ts
// a tool round that fails mid-way still records its completed calls

import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeTempDirPool } from '../helpers/temp.js'
import { makeAgentEvents, makeFakeAgent } from '../helpers/agent-harness.js'

const { tempDir } = makeTempDirPool()

test('a throwing onToolResult keeps the write and a result per call in history', async () =>
{
  const dir = await tempDir('coral-failed-round-')
  const { agent } = makeFakeAgent(
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
                  name: 'write_file',
                  arguments: { path: 'a.txt', content: 'hello\n' },
                },
              },
              {
                type: 'function',
                function: { name: 'read_file', arguments: { path: 'a.txt' } },
              },
            ],
          },
          done: true,
        },
      ],
    ],
    { verifyEdits: false }
  )

  let error: Error | undefined
  const outcome = await agent.run(
    'write a.txt',
    makeAgentEvents({
      onToolResult()
      {
        throw new Error('host callback failed')
      },
      onError(value)
      {
        error = value
      },
    })
  )

  assert.equal(outcome.status, 'failed')
  assert.match(error!.message, /host callback failed/)
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf-8'), 'hello\n')

  const messages = agent.getMessages()
  const callIndex = messages.findIndex(
    (message) => message.role === 'assistant' && message.tool_calls?.length
  )
  assert.notEqual(callIndex, -1)
  assert.deepEqual(
    messages[callIndex]!.tool_calls!.map((call) => call.function.name),
    ['write_file', 'read_file']
  )
  const results = messages.slice(callIndex + 1)
  assert.deepEqual(
    results.map((message) => [message.role, message.tool_name]),
    [
      ['tool', 'write_file'],
      ['tool', 'read_file'],
    ]
  )
  assert.equal(results[1]!.content, 'Error: Tool call interrupted')
  await agent.dispose()
})
