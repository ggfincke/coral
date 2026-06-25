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
      { tools: [tool], registerSubagent: false, verifyEdits: false }
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
    { tools: [tool], registerSubagent: false, verifyEdits: false },
    'http://ollama-a.test'
  )

  const controller = new AbortController()

  await agent.run('run tool', makeAgentEvents(), controller.signal)

  assert.equal(seenContext?.cwd, dir)
  assert.equal(seenContext?.ollamaHost, 'http://ollama-a.test')
  assert.equal(seenContext?.signal, controller.signal)
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
    { tools: [tool], registerSubagent: false, verifyEdits: true }
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
