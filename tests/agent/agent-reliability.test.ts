// tests/agent/agent-reliability.test.ts
// loop-level tests for the tool-call reliability layer

import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { subagentTools } from '../../src/tools/registry.js'
import {
  STALL_NUDGE_MESSAGE,
  MAX_STALL_NUDGES,
} from '../../src/agent/loop/response-repair.js'
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

test('output cutoffs fail without repairing, executing tools, or retrying', async (t) =>
{
  for (const [label, content, nativeCall, thinking] of [
    ['empty', '', false, ''],
    ['thinking only', '', false, 'unfinished reasoning'],
    ['partial text', 'Partial answer', false, 'unfinished reasoning'],
    [
      'text tool call',
      '{"name":"read_file","arguments":{"path":"package.json"}}',
      false,
      '',
    ],
    ['native tool call', 'Partial answer', true, 'unfinished reasoning'],
  ] as const)
  {
    await t.test(label, async () =>
    {
      const { agent, streams } = await makeAgent([
        [
          {
            message: {
              role: 'assistant',
              content,
              thinking,
              tool_calls: nativeCall
                ? [
                    {
                      function: {
                        name: 'read_file',
                        arguments: { path: 'package.json' },
                      },
                    },
                  ]
                : undefined,
            },
            done: true,
            done_reason: 'length',
          },
        ],
      ])
      const calls: string[] = []
      let error: Error | undefined
      let done = false
      let reason: string | undefined
      try
      {
        const outcome = await agent.run(
          'inspect',
          makeAgentEvents({
            onToolCall: (name) =>
            {
              calls.push(name)
            },
            onError: (value) =>
            {
              error = value
            },
            onDone: () =>
            {
              done = true
            },
            onUsage: (usage) =>
            {
              reason = usage.doneReason
            },
          })
        )
        assert.equal(outcome.status, 'failed')
        assert.match(error!.message, /output token limit/)
        assert.equal(reason, 'length')
        assert.equal(done, false)
        assert.equal(streams(), 1)
        assert.deepEqual(calls, [])
        assert.equal(agent.getReliabilityStats().stallNudges, 0)
        assert.equal(agent.getReliabilityStats().repairedToolCalls, 0)
        assert.equal(agent.getReliabilityStats().reprompts, 0)
        const replies = agent
          .getMessages()
          .filter((message) => message.role === 'assistant')
        assert.equal(replies.length, content ? 1 : 0)
        if (content)
        {
          assert.equal(replies[0]!.content, content)
          assert.equal(replies[0]!.tool_calls, undefined)
        }
      }
      finally
      {
        await agent.dispose()
      }
    })
  }
})
