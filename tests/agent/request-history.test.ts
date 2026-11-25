// tests/agent/request-history.test.ts
// request prefix stability & message-count trim regressions

import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CompactionResult } from '../../src/agent/agent.js'
import { ConversationState } from '../../src/agent/state/conversation.js'
import type {
  ChatRequest,
  ModelRequestMessage,
  OllamaMessage,
} from '../../src/types/inference.js'
import {
  makeAgentEvents,
  makeFakeAgent,
  type FakeAgentOptions,
  type FakeChunk,
} from '../helpers/agent-harness.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

function readCall(path: string): FakeChunk[]
{
  return [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            function: { name: 'read_file', arguments: { path } },
          },
        ],
      },
      done: true,
    },
  ]
}

const final: FakeChunk[] = [
  { message: { role: 'assistant', content: 'done' }, done: true },
]

// the byte stream a provider tokenizes, w/o the closing bracket
function streamBytes(messages: readonly ModelRequestMessage[]): string
{
  return JSON.stringify(messages).slice(0, -1)
}

// drive turns through the real planner and keep every request it built
function capturingAgent(
  dir: string,
  rounds: (round: number) => FakeChunk[],
  options: FakeAgentOptions = {}
)
{
  const requests: ModelRequestMessage[][] = []
  let round = 0
  const fake = makeFakeAgent(
    dir,
    async function* (request?: ChatRequest)
    {
      round++
      requests.push(structuredClone(request!.messages))
      yield* rounds(round)
    },
    { numCtx: 32_768, ...options }
  )
  return {
    ...fake,
    requests,
    nextTurn()
    {
      round = 0
    },
  }
}

async function writeFiles(dir: string, count: number): Promise<void>
{
  for (let index = 1; index <= count; index++)
  {
    await writeFile(join(dir, `file-${index}.txt`), `body ${index}\n`)
  }
}

test('the message-count guard trims once to a turn start and keeps surviving undo', async () =>
{
  const dir = await tempDir('coral-count-trim-')
  await writeFiles(dir, 4)
  // system + 99 small messages, far below any token threshold
  const prior: OllamaMessage[] = Array.from({ length: 99 }, (_unused, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `prior ${i}`,
  }))
  const { agent, requests } = capturingAgent(dir, (round) =>
    round <= 3 ? readCall(`file-${round}.txt`) : final
  )
  agent.restoreMessages([{ role: 'system', content: 'System' }, ...prior])
  // the newest prior turn starts at 'prior 96' and runs to the history tip
  agent.restoreUndoStack([
    {
      startIndex: 97,
      endIndex: 100,
      userMessage: 'prior 96',
      messages: prior.slice(96),
      changes: [],
    },
  ])

  const compactions: CompactionResult[] = []
  await agent.run(
    'one more question',
    makeAgentEvents({ onCompaction: (result) => compactions.push(result) })
  )

  assert.deepEqual(
    compactions.map((result) => [result.type, result.trimReason]),
    [['trimmed', 'message_limit']]
  )
  assert.ok(agent.getMessageCount() <= 80)
  assert.equal(requests.length, 4)
  for (let index = 1; index < requests.length; index++)
  {
    assert.ok(
      streamBytes(requests[index]!).startsWith(
        streamBytes(requests[index - 1]!)
      ),
      `request ${index} rewrote an earlier request's bytes`
    )
  }

  // the trim kept the prior turn's undo record, rebased onto its new index
  assert.equal((await agent.undoLastTurn()).ok, true)
  const priorUndo = await agent.undoLastTurn()
  assert.equal(priorUndo.ok, true)
  assert.equal(agent.getMessages().at(-1)?.content, 'prior 95')
})

test('dropping the turn that held the newest Git snapshot moves it onto a kept turn', () =>
{
  const turns = (state: ConversationState) =>
  {
    state.appendMessages([
      { role: 'user', content: 'turn one', gitContext: '## Git Context\nA' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'turn two' },
      { role: 'assistant', content: 'answer two' },
    ])
  }

  const trimmed = new ConversationState('system')
  turns(trimmed)
  trimmed.trimToMax(3)
  assert.equal(trimmed.getMessages()[1]?.content, 'turn two')
  assert.equal(trimmed.newestGitContext(), '## Git Context\nA')

  const summarized = new ConversationState('system')
  turns(summarized)
  const prepared = summarized.prepareSummary({
    mode: 'manual',
    config: {
      contextWindow: 8_192,
      minRecentMessages: 2,
      minMessagesForCompaction: 4,
    },
  })!
  summarized.commitSummary(prepared.plan, 'summary', '2026-11-25T00:00:00Z')
  const kept = summarized.getMessages().find((m) => m.content === 'turn two')
  assert.equal(kept?.gitContext, '## Git Context\nA')
})

test('a new top-level entry between turns leaves the system message unchanged', async () =>
{
  const dir = await tempDir('coral-root-freeze-')
  await writeFiles(dir, 2)
  const { agent, requests, nextTurn } = capturingAgent(dir, (round) =>
    round === 1 ? readCall('file-1.txt') : final
  )

  await agent.run('first turn', makeAgentEvents())
  await mkdir(join(dir, '.pytest_cache'))
  nextTurn()
  await agent.run('second turn', makeAgentEvents())

  assert.equal(requests.length, 4)
  assert.equal(requests[3]![0]!.content, requests[0]![0]!.content)
  assert.ok(streamBytes(requests[2]!).startsWith(streamBytes(requests[1]!)))
})

test('an outstanding file-change notice stays where it first went out', async () =>
{
  const dir = await tempDir('coral-notice-place-')
  await writeFiles(dir, 5)
  const { agent, requests } = capturingAgent(
    dir,
    (round) =>
    {
      if (round === 2)
      {
        writeFileSync(join(dir, 'file-1.txt'), 'changed outside coral\n')
      }
      return round <= 4 ? readCall(`file-${round}.txt`) : final
    },
    { trackFileChanges: true }
  )

  await agent.run('read the files', makeAgentEvents())

  const notices = requests.map((messages) =>
    messages.findIndex((message) =>
      message.content.startsWith('Workspace file changes')
    )
  )
  const first = notices.findIndex((index) => index >= 0)
  assert.ok(first > 0, 'the notice never went out')
  // three or more rounds carry the same notice at the same position
  assert.ok(requests.length - first >= 3)
  for (let index = first + 1; index < requests.length; index++)
  {
    assert.equal(notices[index], notices[first])
    assert.ok(
      streamBytes(requests[index]!).startsWith(
        streamBytes(requests[index - 1]!)
      )
    )
  }
})
