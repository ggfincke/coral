// tests/agent.test.ts
// regression tests for the agent tool-use loop

import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Agent } from '../src/agent/agent.js'
import type { Tool, ToolExecutionContext } from '../src/tools/index.js'
import type { SubagentResult } from '../src/tools/subagent.js'
import type { OllamaMessage } from '../src/types/inference.js'
import { GIT_CONTEXT_HEADING } from '../src/agent/git-context.js'
import {
  estimateTotalTokens,
  FROZEN_SUMMARY_MARKER,
} from '../src/agent/compaction.js'
import { makeTempDirPool } from './helpers/temp.js'
import { HAS_GIT, initTestRepo } from './helpers/git.js'
import { makeFakeAgent, makeAgentEvents } from './helpers/agent-harness.js'

const { tempDir } = makeTempDirPool()

type ReadOnlySubagentPatch = Agent & {
  runReadOnlySubagent: (
    prompt: string,
    signal?: AbortSignal
  ) => Promise<SubagentResult>
}

test('Agent accumulates streamed tool calls, preserves thinking, & tags tool results', async () =>
{
  const dir = await tempDir('coral-agent-')

  await mkdir(join(dir, 'src'))
  await writeFile(
    join(dir, 'package.json'),
    '{\n  "name": "fixture"\n}\n',
    'utf-8'
  )
  await writeFile(
    join(dir, 'src', 'example.ts'),
    'export const value = 1;\n',
    'utf-8'
  )

  const { agent } = makeFakeAgent(dir, [
    [
      {
        message: {
          role: 'assistant',
          content: '',
          thinking: 'Inspect files. ',
          tool_calls: [
            {
              type: 'function',
              function: {
                index: 1,
                name: 'glob',
                arguments: { pattern: 'src/**/*.ts' },
              },
            },
          ],
        },
        done: false,
      },
      {
        message: {
          role: 'assistant',
          content: '',
          thinking: 'Then read package metadata.',
          tool_calls: [
            {
              type: 'function',
              function: {
                index: 0,
                name: 'read_file',
                arguments: { path: 'package.json' },
              },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ])

  const seenCalls: string[] = []
  const seenResults: string[] = []
  const seenThinking: string[] = []

  await agent.run(
    'inspect the repo',
    makeAgentEvents({
      onThinking(thinking)
      {
        seenThinking.push(thinking)
      },
      onToolCall(name)
      {
        seenCalls.push(name)
      },
      onToolResult(name, result, error)
      {
        seenResults.push(`${name}:${error ?? result.split('\n')[0]}`)
      },
    })
  )

  assert.deepEqual(seenCalls, ['read_file', 'glob'])
  assert.equal(seenResults.length, 2)
  assert.deepEqual(seenThinking, [
    'Inspect files. ',
    'Then read package metadata.',
  ])

  const assistantToolTurn = agent.messages.find(
    (message) => message.tool_calls?.length === 2
  )
  assert.ok(assistantToolTurn)
  assert.equal(
    assistantToolTurn.thinking,
    'Inspect files. Then read package metadata.'
  )
  assert.deepEqual(
    assistantToolTurn.tool_calls?.map((call) => call.function.name),
    ['read_file', 'glob']
  )

  const toolMessages = agent.messages.filter(
    (message) => message.role === 'tool'
  )
  assert.equal(toolMessages.length, 2)
  assert.deepEqual(
    toolMessages.map((message) => message.tool_name),
    ['read_file', 'glob']
  )
})

test(
  'Agent sends volatile git context without persisting it',
  { skip: !HAS_GIT },
  async () =>
  {
    const dir = await tempDir('coral-git-context-agent-')
    const run = initTestRepo(dir)
    await writeFile(join(dir, 'note.txt'), 'hello\n', 'utf-8')
    assert.equal(run('add', '-A').status, 0)
    assert.equal(run('commit', '-m', 'init').status, 0)

    const requests: OllamaMessage[][] = []
    const contextTokens: number[] = []

    // request-inspecting form: capture the messages sent each turn
    const { agent } = makeFakeAgent(dir, async function* (request)
    {
      requests.push(request?.messages ?? [])
      yield {
        message: { role: 'assistant', content: 'ok' },
        done: true,
      }
    })

    await agent.run(
      'first',
      makeAgentEvents({
        onUsage(usage)
        {
          contextTokens.push(usage.contextTokens)
        },
      })
    )
    await agent.run(
      'second',
      makeAgentEvents({
        onUsage(usage)
        {
          contextTokens.push(usage.contextTokens)
        },
      })
    )

    assert.equal(requests.length, 2)
    assert.deepEqual(contextTokens, requests.map(estimateTotalTokens))
    for (const messages of requests)
    {
      assert.equal(
        messages.filter((message) =>
          message.content.startsWith(GIT_CONTEXT_HEADING)
        ).length,
        1
      )
    }
    assert.equal(
      agent.messages.some((message) =>
        message.content.startsWith(GIT_CONTEXT_HEADING)
      ),
      false
    )
  }
)

test(
  'Agent rebuilds volatile git context for each model request',
  { skip: !HAS_GIT },
  async () =>
  {
    const dir = await tempDir('coral-git-context-refresh-')
    const run = initTestRepo(dir)
    await writeFile(join(dir, 'note.txt'), 'hello\n', 'utf-8')
    assert.equal(run('add', '-A').status, 0)
    assert.equal(run('commit', '-m', 'init').status, 0)

    const requests: OllamaMessage[][] = []
    const { agent } = makeFakeAgent(dir, async function* (request)
    {
      requests.push(request?.messages ?? [])

      if (requests.length === 1)
      {
        await writeFile(join(dir, 'external.txt'), 'outside change\n', 'utf-8')
        yield {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: { path: 'note.txt' },
                },
              },
            ],
          },
          done: true,
        }
        return
      }

      yield { message: { role: 'assistant', content: 'done' }, done: true }
    })

    await agent.run('inspect', makeAgentEvents())

    assert.equal(requests.length, 2)
    const secondContext = requests[1]!.find((message) =>
      message.content.startsWith(GIT_CONTEXT_HEADING)
    )
    assert.ok(secondContext)
    assert.match(secondContext.content, /external\.txt/)
  }
)

test('getFrozenPrefix reports the system prompt plus frozen summary blocks', async () =>
{
  const dir = await tempDir('coral-frozen-prefix-')

  const { agent } = makeFakeAgent(dir, [])
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: `${FROZEN_SUMMARY_MARKER} ...]\n\nsummary one` },
    { role: 'user', content: `${FROZEN_SUMMARY_MARKER} ...]\n\nsummary two` },
    { role: 'user', content: 'live question' },
    { role: 'assistant', content: 'live answer' },
  ]
  // restoreMessages keeps the agent's own system prompt at index 0, so the
  // frozen prefix is [system, summary one, summary two]
  agent.restoreMessages(messages)

  const frozen = agent.getFrozenPrefix()

  assert.equal(frozen.messages, 3)
  assert.equal(frozen.summaryBlocks, 2)
  assert.equal(
    frozen.tokens,
    estimateTotalTokens(agent.messages.slice(0, frozen.messages))
  )
  assert.ok(frozen.tokens > 0)
  // num_ctx is unresolved until a run pins it, so the window reads 0
  assert.equal(frozen.contextWindow, 0)
})

test('Agent.forceCompact summarizes old turns and records compaction state', async () =>
{
  const dir = await tempDir('coral-force-compact-')
  const { agent, streams } = makeFakeAgent(dir, [
    [
      {
        message: {
          role: 'assistant',
          content: 'Summary:\n- inspected the project\n- kept the current task',
        },
        done: true,
      },
    ],
  ])

  agent.restoreMessages(
    Array.from({ length: 6 }, (_unused, index) => [
      { role: 'user' as const, content: `question ${index + 1}` },
      { role: 'assistant' as const, content: `answer ${index + 1}` },
    ]).flat()
  )
  const beforeMessages = agent.getMessageCount()

  const result = await agent.forceCompact()

  assert.equal(streams(), 1)
  assert.equal(result?.type, 'summarized')
  assert.equal(agent.getCompactionCount(), 1)
  assert.ok(agent.getMessageCount() < beforeMessages)
  assert.ok(
    agent
      .getMessages()
      .some((message) => message.content.startsWith(FROZEN_SUMMARY_MARKER))
  )
  assert.ok(
    agent.getMessages().some((message) => message.content === 'question 6')
  )
})

test('Agent batches only tools marked parallelSafe', async () =>
{
  const dir = await tempDir('coral-parallel-contract-')

  async function runPair(
    name: string,
    metadata: Pick<Tool, 'subagentSafe' | 'parallelSafe'>
  ): Promise<number>
  {
    let active = 0
    let maxActive = 0
    const tool: Tool = {
      name,
      description: 'timed test tool',
      parameters: { type: 'object', properties: {} },
      ...metadata,
      async execute()
      {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active -= 1
        return { output: name }
      },
    }

    const { agent } = makeFakeAgent(
      dir,
      [
        [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { type: 'function', function: { name, arguments: {} } },
                { type: 'function', function: { name, arguments: {} } },
              ],
            },
            done: true,
          },
        ],
        [{ message: { role: 'assistant', content: 'done' }, done: true }],
      ],
      { tools: [tool], verifyEdits: false }
    )

    await agent.run('run two tools', makeAgentEvents())

    return maxActive
  }

  assert.equal(
    await runPair('read_file', { subagentSafe: true, parallelSafe: true }),
    2
  )
  assert.equal(await runPair('search_code', { subagentSafe: true }), 1)
})

test('Agent passes request-scoped execution context to tools', async () =>
{
  const dir = await tempDir('coral-tool-context-')

  let seenContext: ToolExecutionContext | undefined
  const tool: Tool = {
    name: 'read_file',
    description: 'context test tool',
    parameters: { type: 'object', properties: {} },
    async execute(_args, context)
    {
      seenContext = context
      return { output: 'ok' }
    },
  }

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
                function: { name: 'read_file', arguments: {} },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { role: 'assistant', content: 'done' }, done: true }],
    ],
    { tools: [tool], verifyEdits: false },
    'http://ollama-a.test'
  )

  const controller = new AbortController()

  await agent.run('run tool', makeAgentEvents(), controller.signal)

  assert.equal(seenContext?.cwd, dir)
  assert.equal(seenContext?.ollamaHost, 'http://ollama-a.test')
  assert.equal(seenContext?.signal, controller.signal)
})

test('Agent keeps each instance on its own cwd even after another agent is created', async () =>
{
  const firstDir = await tempDir('coral-agent-cwd-a-')
  const secondDir = await tempDir('coral-agent-cwd-b-')
  await writeFile(join(firstDir, 'note.txt'), 'from first\n', 'utf-8')
  await writeFile(join(secondDir, 'note.txt'), 'from second\n', 'utf-8')

  const { agent: firstAgent } = makeFakeAgent(firstDir, [
    [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              type: 'function',
              function: { name: 'read_file', arguments: { path: 'note.txt' } },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ])
  makeFakeAgent(secondDir, [])

  const results: string[] = []
  await firstAgent.run(
    'read the note',
    makeAgentEvents({
      onToolResult(_name, result)
      {
        results.push(result)
      },
    })
  )

  assert.ok(results.includes('from first\n'))
})

test('Agent requires approval for off-workspace read tools', async () =>
{
  const dir = await tempDir('coral-agent-path-policy-')
  const outside = await tempDir('coral-agent-outside-')
  const outsideFile = join(outside, 'secret.txt')
  await writeFile(outsideFile, 'secret\n', 'utf-8')

  const { agent } = makeFakeAgent(dir, [
    [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              type: 'function',
              function: { name: 'read_file', arguments: { path: outsideFile } },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ])

  const approvals: string[] = []
  const results: string[] = []

  await agent.run(
    'read outside',
    makeAgentEvents({
      onToolApproval(name)
      {
        approvals.push(name)
        return Promise.resolve(false)
      },
      onToolResult(name, result, error)
      {
        results.push(`${name}:${error ?? result}`)
      },
    })
  )

  assert.deepEqual(approvals, ['read_file'])
  assert.ok(results.includes('read_file:Tool call rejected by user'))
})

test('Agent uses approval to execute off-workspace read tools', async () =>
{
  const dir = await tempDir('coral-agent-path-policy-approved-')
  const outside = await tempDir('coral-agent-outside-approved-')
  const outsideFile = join(outside, 'secret.txt')
  await writeFile(outsideFile, 'secret\n', 'utf-8')

  const { agent } = makeFakeAgent(dir, [
    [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              type: 'function',
              function: { name: 'read_file', arguments: { path: outsideFile } },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ])

  const approvals: string[] = []
  const results: string[] = []

  await agent.run(
    'read outside',
    makeAgentEvents({
      onToolApproval(name)
      {
        approvals.push(name)
        return Promise.resolve(true)
      },
      onToolResult(name, result, error)
      {
        results.push(`${name}:${error ?? result}`)
      },
    })
  )

  assert.deepEqual(approvals, ['read_file'])
  assert.ok(results.includes('read_file:secret\n'))
})

test('Agent validates malformed path args before workspace policy checks', async () =>
{
  const dir = await tempDir('coral-agent-path-validation-')
  const { agent } = makeFakeAgent(dir, [
    [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'read_file',
                arguments: { path: { nested: true } },
              },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ])

  const approvals: string[] = []
  const errors: string[] = []

  await agent.run(
    'read malformed',
    makeAgentEvents({
      onToolApproval(name)
      {
        approvals.push(name)
        return Promise.resolve(true)
      },
      onToolResult(_name, _result, error)
      {
        if (error) errors.push(error)
      },
    })
  )

  assert.deepEqual(approvals, [])
  assert.match(errors[0] ?? '', /Invalid arguments for read_file/)
})

test('Agent ignores stale context-window resolutions after a model switch', async () =>
{
  const dir = await tempDir('coral-context-switch-')
  const { agent } = makeFakeAgent(dir, [])

  let resolveOld!: () => void
  const oldReady = new Promise<void>((resolve) =>
  {
    resolveOld = resolve
  })
  agent.client = {
    startKeepAlive()
    {},
    async unloadModel()
    {},
    async showModel(model: string)
    {
      if (model === 'fake-model') await oldReady
      return {
        contextLength: model === 'fake-model' ? 8_192 : 32_768,
        architecture: 'gemma',
      }
    },
    async listModels()
    {
      return [
        { name: 'fake-model', model: 'fake-model', size: 0, modified_at: '' },
        { name: 'next-model', model: 'next-model', size: 0, modified_at: '' },
      ]
    },
    async *chatStream()
    {},
  } as TestAgent['client']

  const stale = agent.fetchContextWindow()
  await agent.switchModel('next-model')
  resolveOld()

  assert.equal(await stale, 0)
  assert.equal(await agent.fetchContextWindow(), 32_768)
})

test('Agent.switchModel adopts the new model only after the old one unloads', async () =>
{
  const dir = await tempDir('coral-switch-order-')
  const { agent } = makeFakeAgent(dir, [])

  let resolveUnload!: () => void
  const unloadGate = new Promise<void>((resolve) =>
  {
    resolveUnload = resolve
  })
  let requestedModel: string | undefined
  agent.client = {
    startKeepAlive()
    {},
    async unloadModel()
    {
      await unloadGate
    },
    async showModel()
    {
      return { contextLength: 8_192, architecture: 'gemma' }
    },
    async listModels()
    {
      return [
        { name: 'next-model', model: 'next-model', size: 0, modified_at: '' },
      ]
    },
    async *chatStream(request)
    {
      requestedModel = request?.model
      yield { message: { role: 'assistant', content: 'done' }, done: true }
    },
  } as TestAgent['client']

  const switching = agent.switchModel('next-model')
  // unload is gated, so the model must not have flipped yet
  assert.equal(agent.getModel(), 'fake-model')

  resolveUnload()
  await switching
  // the new model is adopted only after the old one finished unloading
  assert.equal(agent.getModel(), 'next-model')

  // the next run targets the switched-in model, never the pre-switch one
  await agent.run('hello', makeAgentEvents())
  assert.equal(requestedModel, 'next-model')
})

test('Agent.forceCompact passes the abort signal to the summary request', async () =>
{
  const dir = await tempDir('coral-compact-abort-')
  const { agent } = makeFakeAgent(dir, [])
  agent.restoreMessages([
    { role: 'system', content: 'System' },
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'four' },
  ])

  const controller = new AbortController()
  let seenSignal: AbortSignal | undefined
  agent.client = {
    startKeepAlive()
    {},
    async *chatStream(_request, signal)
    {
      seenSignal = signal
      controller.abort()
      if (!signal?.aborted)
      {
        yield { message: { role: 'assistant', content: '' }, done: true }
      }
    },
  } as TestAgent['client']

  const result = await agent.forceCompact(controller.signal)

  assert.equal(seenSignal, controller.signal)
  assert.equal(result, null)
})

test('Agent.run leaves history untouched when automatic compaction is aborted', async () =>
{
  const dir = await tempDir('coral-auto-compact-abort-')
  // small num_ctx so the restored history trips automatic summarization, &
  // pins the context window so fetchContextWindow short-circuits the showModel
  const { agent } = makeFakeAgent(dir, [], { numCtx: 256 })

  // 120 alternating turns -> over MAX_HISTORY (100), so a fallback trim would
  // visibly drop messages if the abort path failed to bail out
  agent.restoreMessages(
    Array.from({ length: 120 }, (_unused, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `msg ${index + 1} ${'x'.repeat(40)}`,
    }))
  )

  const controller = new AbortController()
  let streamCalls = 0
  agent.client = {
    startKeepAlive()
    {},
    async *chatStream(_request, signal)
    {
      // first stream is the summary request — abort mid-stream
      streamCalls += 1
      controller.abort()
      yield { message: { role: 'assistant', content: 'partial' }, done: false }
      void signal
    },
  } as TestAgent['client']

  let doneCalled = false
  await agent.run(
    'next request',
    makeAgentEvents({
      onDone()
      {
        doneCalled = true
      },
    }),
    controller.signal
  )

  // only the aborted summary attempt ran — no post-compaction model request
  assert.equal(streamCalls, 1)
  // abort is a cancellation, not a compaction failure
  assert.equal(agent.getCompactionCount(), 0)
  // no trim: 120 restored turns + the new user message survive intact
  assert.equal(agent.getMessageCount(), 121)
  const messages = agent.getMessages()
  assert.ok(
    !messages.some((message) =>
      message.content.startsWith(FROZEN_SUMMARY_MARKER)
    )
  )
  // head & tail of history are preserved (a trim would drop the oldest turns)
  assert.ok(messages[1]?.content.startsWith('msg 1 '))
  assert.equal(messages.at(-1)?.content, 'next request')
  // run() still completed cleanly
  assert.ok(doneCalled)
})

test('Agent verifies edit diffs recorded from tool results', async () =>
{
  const dir = await tempDir('coral-verify-diff-')

  const tool: Tool = {
    name: 'read_file',
    description: 'diff-producing test tool',
    parameters: { type: 'object', properties: {} },
    async execute()
    {
      return {
        output: 'changed',
        diff: '--- a/example.ts\n+++ b/example.ts\n@@\n-old\n+new\n',
      }
    },
  }

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
                function: { name: 'read_file', arguments: {} },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { role: 'assistant', content: 'done' }, done: true }],
    ],
    { tools: [tool], verifyEdits: true }
  )

  const prototype = Agent.prototype as unknown as ReadOnlySubagentPatch
  const originalRunReadOnlySubagent = prototype.runReadOnlySubagent
  let verifyPrompt = ''

  prototype.runReadOnlySubagent = async (prompt: string) =>
  {
    verifyPrompt = prompt
    return {
      text: 'VERDICT: FAIL - diff mismatch',
      aborted: false,
    }
  }

  try
  {
    const verdicts: string[] = []
    const retried: (boolean | undefined)[] = []
    await agent.run(
      'apply the requested edit',
      makeAgentEvents({
        onVerification(result)
        {
          verdicts.push(`${result.status}:${result.reason ?? ''}`)
          retried.push(result.retrying)
        },
      })
    )

    assert.ok(verifyPrompt.includes('apply the requested edit'))
    assert.ok(verifyPrompt.includes('example.ts'))
    // a FAIL feeds back one fix attempt, then re-verifies & finishes warn-only
    assert.deepEqual(verdicts, ['fail:diff mismatch', 'fail:diff mismatch'])
    assert.deepEqual(retried, [true, false])
    assert.equal(agent.getReliabilityStats().verifyReprompts, 1)
  }
  finally
  {
    prototype.runReadOnlySubagent = originalRunReadOnlySubagent
  }
})

test('Agent only asks approval for dangerous tools & records rejections as tool results', async () =>
{
  const dir = await tempDir('coral-approval-')

  await writeFile(join(dir, 'note.txt'), 'hello from coral\n', 'utf-8')

  const { agent } = makeFakeAgent(dir, [
    [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'read_file',
                arguments: { path: 'note.txt' },
              },
            },
            {
              type: 'function',
              function: {
                name: 'bash',
                arguments: { command: 'pwd' },
              },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ])

  const approvals: string[] = []
  const results: string[] = []

  await agent.run(
    'inspect the repo',
    makeAgentEvents({
      onToolResult(name, result, error)
      {
        results.push(`${name}:${error ?? result.split('\n')[0]}`)
      },
      onToolApproval(name)
      {
        approvals.push(name)
        return Promise.resolve(false)
      },
    })
  )

  assert.deepEqual(approvals, ['bash'])
  assert.ok(
    results.some((entry) => entry.startsWith('read_file:hello from coral'))
  )
  assert.ok(results.includes('bash:Tool call rejected by user'))

  const bashToolMessage = agent.messages.find(
    (message) => message.role === 'tool' && message.tool_name === 'bash'
  )
  assert.ok(bashToolMessage)
  assert.equal(bashToolMessage.content, 'Error: Tool call rejected by user')
})

test('aborting mid-tools records a reply for every announced tool_call', async () =>
{
  const dir = await tempDir('coral-abort-')
  await writeFile(join(dir, 'note.txt'), 'hello\n', 'utf-8')

  const { agent } = makeFakeAgent(dir, [
    [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              type: 'function',
              function: { name: 'read_file', arguments: { path: 'note.txt' } },
            },
            {
              type: 'function',
              function: { name: 'bash', arguments: { command: 'pwd' } },
            },
            {
              type: 'function',
              function: { name: 'read_file', arguments: { path: 'note.txt' } },
            },
          ],
        },
        done: true,
      },
    ],
  ])

  // abort while the approval-gated bash call is pending, mid-batch
  const controller = new AbortController()

  await agent.run(
    'go',
    makeAgentEvents({
      onToolApproval()
      {
        controller.abort()
        return new Promise<boolean>(() =>
        {})
      },
    }),
    controller.signal
  )

  // every tool_call in the assistant turn must have exactly one matching reply
  const assistant = agent.messages.find(
    (message) => message.role === 'assistant' && message.tool_calls
  )
  assert.ok(assistant?.tool_calls)
  const toolReplies = agent.messages.filter(
    (message) => message.role === 'tool'
  )
  assert.equal(toolReplies.length, assistant.tool_calls!.length)

  const bashReply = agent.messages.find(
    (message) => message.role === 'tool' && message.tool_name === 'bash'
  )
  assert.match(bashReply?.content ?? '', /interrupted/i)
})

test('Agent stops after maxIterations tool-call rounds', async () =>
{
  const dir = await tempDir('coral-maxiter-')

  // a model that always asks for one more unknown tool; w/o the cap the
  // loop would never terminate
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
                function: { index: 0, name: 'noop', arguments: {} },
              },
            ],
          },
          done: true,
        },
      ],
    ],
    { maxIterations: 3 }
  )

  let done = false
  await agent.run(
    'loop forever',
    makeAgentEvents({
      onDone()
      {
        done = true
      },
    })
  )

  assert.equal(done, true)
  assert.equal(streams(), 3)
})
