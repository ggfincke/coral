// tests/agent-reliability.test.ts
// loop-level tests for the tool-call reliability layer

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Agent } from '../src/agent/agent.js'
import { subagentTools } from '../src/tools/index.js'
import { STALL_NUDGE_MESSAGE, MAX_STALL_NUDGES } from '../src/agent/repair.js'
import type { OllamaMessage } from '../src/types/inference.js'

const tempDirs: string[] = []

after(async () =>
{
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

interface FakeChunk
{
  message: Partial<OllamaMessage>
  done: boolean
}

type TestAgent = Agent & {
  client: {
    startKeepAlive: (model: string) => void
    chatStream: () => AsyncGenerator<FakeChunk>
  }
  messages: OllamaMessage[]
}

// build an agent whose client replays one chunk array per model turn
async function makeAgent(
  turns: FakeChunk[][],
  options?: ConstructorParameters<typeof Agent>[3]
): Promise<{ agent: TestAgent; streams: () => number }>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-reliability-'))
  tempDirs.push(dir)
  await writeFile(join(dir, 'package.json'), '{\n  "name": "fixture"\n}\n')

  const agent = new Agent(
    'fake-model',
    'http://localhost:11434',
    dir,
    options
  ) as TestAgent

  let streamCount = 0
  agent.client = {
    startKeepAlive()
    {},
    async *chatStream()
    {
      const turn = turns[Math.min(streamCount, turns.length - 1)]!
      streamCount += 1
      yield* turn
    },
  }

  return { agent, streams: () => streamCount }
}

// minimal event sink that records calls & results
function makeEvents(seenCalls: string[], seenResults: string[])
{
  return {
    onToken()
    {},
    onToolCall(name: string)
    {
      seenCalls.push(name)
    },
    onToolResult(name: string, result: string, error: string | undefined)
    {
      seenResults.push(`${name}:${error ?? 'ok'}`)
    },
    onToolApproval()
    {
      return Promise.resolve(true)
    },
    onDone()
    {},
    onError(error: Error)
    {
      throw error
    },
  }
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
  const repairedTurn = agent.messages.find(
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

  const nudges = agent.messages.filter(
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
    { tools: subagentTools, registerSubagent: false }
  )

  const seenResults: string[] = []
  await agent.run('plan', makeEvents([], seenResults))

  assert.match(seenResults[0]!, /Unknown tool: todo_write/)
})
