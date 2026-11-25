// tests/tui/agent-turn.test.ts
// run the real useAgentTurn hook over a real Agent loop, tool, and runtime

import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test, type TestContext } from 'node:test'
import { act, createElement, useEffect } from 'react'
import { render, Text } from 'ink'
import type { Agent } from '../../src/agent/agent.js'
import { InteractiveSessionRuntime } from '../../src/runtime/interactive-session.js'
import {
  useAgentTurn,
  type AgentTurnController,
} from '../../src/tui/run/use-agent-turn.js'
import type { InteractiveSession } from '../../src/tui/session/use-interactive-session.js'
import type { OutputBlock } from '../../src/tui/transcript/types.js'
import { makeFakeAgent, type FakeStream } from '../helpers/agent-harness.js'
import { makeSessionMeta } from '../helpers/session.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

interface TurnHarness
{
  runtime: InteractiveSessionRuntime<Agent>
  controller: () => AgentTurnController
  streams: () => number
}

// only the members useAgentTurn reads, each backed by the real runtime
function sessionFor(
  runtime: InteractiveSessionRuntime<Agent>,
  agent: Agent
): InteractiveSession
{
  const session: Partial<InteractiveSession> = {
    agent,
    activePrompt: null,
    acceptsEvent: (handle) => runtime.acceptsEvent(handle),
    beginOperation: (kind) => runtime.beginOperation(kind),
    completeTurn: (handle) => ({
      ...runtime.completeTurn(handle),
      saveRefused: false,
    }),
    getSessionId: () => runtime.getSessionId(),
    isYolo: () => false,
    requestPrompt: (handle, prompt) => runtime.requestPrompt(handle, prompt),
    requestToolApproval: (handle, request) =>
      runtime.requestToolApproval(handle, request),
    runOperation: (handle, work) => runtime.runOperation(handle, work),
  }
  return session as InteractiveSession
}

async function mountTurn(
  t: TestContext,
  script: FakeStream,
  addHistoryEntry: (text: string) => void = () => undefined
): Promise<TurnHarness>
{
  const reactEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
  const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true

  const dir = await tempDir()
  await writeFile(join(dir, 'notes.txt'), 'alpha\n')
  const { agent, streams } = makeFakeAgent(dir, script)
  const runtime = new InteractiveSessionRuntime<Agent>(
    {
      persist: (_agent, target) => target ?? makeSessionMeta(),
      recordTelemetry: () => undefined,
      onPromptChange: () => undefined,
      onSessionChange: () => undefined,
      onTransitionChange: () => undefined,
    },
    agent,
    null
  )
  const session = sessionFor(runtime, agent)
  let latest: AgentTurnController | undefined

  function Harness()
  {
    const controller = useAgentTurn({
      initialSession: null,
      session,
      addHistoryEntry,
      clearInput: () => undefined,
      scrollToLatest: () => undefined,
      onInterrupted: () => undefined,
    })
    useEffect(() =>
    {
      latest = controller
    })
    return createElement(Text, null, String(controller.output.length))
  }

  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode()
    {},
  })
  let view: ReturnType<typeof render>
  await act(async () =>
  {
    view = render(createElement(Harness), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    })
  })
  t.after(async () =>
  {
    await act(async () =>
    {
      view.cleanup()
    })
    await runtime.shutdown()
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  })
  return { runtime, controller: () => latest!, streams }
}

async function submit(harness: TurnHarness, text: string): Promise<void>
{
  await act(async () =>
  {
    await harness
      .controller()
      .run(text, { historyRecorded: false, attachmentPaths: [] })
  })
}

function summarize(blocks: OutputBlock[]): string[]
{
  return blocks.map((block) =>
  {
    if (block.type === 'tool_call')
      return `tool_call:${block.status ?? 'pending'}:${block.callId}`
    if (block.type === 'assistant' || block.type === 'system')
      return `${block.type}:${block.content}`
    return block.type
  })
}

test('a tool turn projects text, its call, its result, and the answer in order', async (t) =>
{
  let round = 0
  const harness = await mountTurn(t, async function* ()
  {
    round += 1
    if (round === 1)
    {
      yield { message: { role: 'assistant', content: 'Looking' }, done: false }
      yield {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              type: 'function',
              function: {
                index: 0,
                name: 'read_file',
                arguments: { path: 'notes.txt' },
              },
            },
          ],
        },
        done: true,
      }
      return
    }
    yield { message: { role: 'assistant', content: 'Done' }, done: true }
  })

  await submit(harness, 'read the notes')

  const output = harness.controller().output
  assert.deepEqual(
    output.map((block) => block.type),
    ['user', 'assistant', 'tool_call', 'tool_result', 'assistant']
  )
  const call = output[2]
  assert.ok(call?.type === 'tool_call')
  assert.equal(call.status, 'success')
  assert.equal(typeof call.callId, 'number')
  assert.equal(harness.runtime.hasActiveOperation(), false)
})

test('an abort keeps the partial answer and settles pending tool calls', async (t) =>
{
  let tokenSeen!: () => void
  const seen = new Promise<void>((resolve) =>
  {
    tokenSeen = resolve
  })
  const harness = await mountTurn(t, async function* (_request, signal)
  {
    yield { message: { role: 'assistant', content: 'partial' }, done: false }
    tokenSeen()
    await new Promise<void>((resolve) =>
    {
      if (signal?.aborted) resolve()
      signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    signal?.throwIfAborted()
  })

  let turn!: Promise<void>
  await act(async () =>
  {
    turn = harness
      .controller()
      .run('start', { historyRecorded: false, attachmentPaths: [] })
    await seen
  })
  await act(async () =>
  {
    assert.equal(harness.runtime.abortActive(), true)
    await turn
  })

  const summary = summarize(harness.controller().output)
  assert.deepEqual(summary.slice(-2), [
    'assistant:partial',
    'system:Generation interrupted',
  ])
  assert.ok(!summary.some((line) => line.startsWith('tool_call:pending')))
  assert.equal(harness.runtime.hasActiveOperation(), false)
})

test('a failed prompt-history write still runs the turn and admits the next one', async (t) =>
{
  let failures = 1
  const harness = await mountTurn(
    t,
    async function* ()
    {
      yield { message: { role: 'assistant', content: 'ok' }, done: true }
    },
    () =>
    {
      if (failures-- > 0) throw new Error('EACCES: history.jsonl')
    }
  )

  await submit(harness, 'first')
  assert.equal(harness.streams(), 1)
  assert.equal(harness.runtime.hasActiveOperation(), false)
  assert.ok(
    summarize(harness.controller().output).includes(
      'system:Prompt history not saved: EACCES: history.jsonl'
    )
  )

  await submit(harness, 'second')
  assert.equal(harness.streams(), 2)
  assert.equal(harness.runtime.hasActiveOperation(), false)
})
