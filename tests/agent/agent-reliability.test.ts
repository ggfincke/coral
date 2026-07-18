// tests/agent/agent-reliability.test.ts
// loop-level tests for the tool-call reliability layer

import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { subagentTools } from '../../src/tools/index.js'
import {
  STALL_NUDGE_MESSAGE,
  MAX_STALL_NUDGES,
} from '../../src/agent/repair.js'
import { makeTempDirPool } from '../helpers/temp.js'
import {
  makeFakeAgent,
  makeAgentEvents,
  type FakeChunk,
} from '../helpers/agent-harness.js'

const { tempDir } = makeTempDirPool()

// build an agent whose client replays one chunk array per model turn
async function makeAgent(
  turns: FakeChunk[][],
  options?: Parameters<typeof makeFakeAgent>[2]
)
{
  const dir = await tempDir('coral-reliability-')
  await writeFile(join(dir, 'package.json'), '{\n  "name": "fixture"\n}\n')
  return makeFakeAgent(dir, turns, options)
}

// minimal event sink that records calls & results
function makeEvents(seenCalls: string[], seenResults: string[])
{
  return makeAgentEvents({
    onToolCall(name)
    {
      seenCalls.push(name)
    },
    onToolResult(name, _result, error)
    {
      seenResults.push(`${name}:${error ?? 'ok'}`)
    },
  })
}

test('repairs a tool call emitted as text content & dispatches it', async () =>
{
  const { agent, streams } = await makeAgent([
    [
      {
        message: {
          role: 'assistant',
          content:
            'I will read the file now: {"name": "read_file", "arguments": {"path": "package.json"}}',
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ])

  const seenCalls: string[] = []
  const seenResults: string[] = []
  await agent.run('inspect', makeEvents(seenCalls, seenResults))

  assert.deepEqual(seenCalls, ['read_file'])
  assert.equal(streams(), 2)
  assert.equal(agent.getReliabilityStats().repairedToolCalls, 1)

  // history carries the recovered tool_calls, not just raw JSON text
  const repairedTurn = agent
    .getMessages()
    .find(
      (message) => message.role === 'assistant' && message.tool_calls?.length
    )
  assert.ok(repairedTurn)
  assert.equal(repairedTurn.tool_calls?.[0]?.function.name, 'read_file')
})

test('nudges a fully empty turn & stops at the nudge cap', async () =>
{
  const emptyTurn: FakeChunk[] = [
    { message: { role: 'assistant', content: '' }, done: true },
  ]
  const { agent, streams } = await makeAgent([emptyTurn])

  let doneCount = 0
  await agent.run('hello', {
    ...makeEvents([], []),
    onDone()
    {
      doneCount += 1
    },
  })

  // initial turn + one retry per allowed nudge, then accept the empty turn
  assert.equal(streams(), MAX_STALL_NUDGES + 1)
  assert.equal(doneCount, 1)

  const nudges = agent
    .getMessages()
    .filter(
      (message) =>
        message.role === 'user' && message.content === STALL_NUDGE_MESSAGE
    )
  assert.equal(nudges.length, MAX_STALL_NUDGES)
})

test('feeds schema validation failures back as tool errors', async () =>
{
  const { agent } = await makeAgent([
    [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              type: 'function',
              function: { index: 0, name: 'read_file', arguments: {} },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ])

  const seenResults: string[] = []
  await agent.run('inspect', makeEvents([], seenResults))

  assert.equal(agent.getReliabilityStats().validationFailures, 1)
  assert.match(seenResults[0]!, /missing required parameter 'path'/)
})

test('restricted toolsets cannot reach tools outside their subset', async () =>
{
  const { agent } = await makeAgent(
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
                  index: 0,
                  name: 'todo_write',
                  arguments: { todos: [] },
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { role: 'assistant', content: 'done' }, done: true }],
    ],
    { tools: subagentTools }
  )

  const seenResults: string[] = []
  await agent.run('plan', makeEvents([], seenResults))

  assert.match(seenResults[0]!, /Unknown tool: todo_write/)
})
