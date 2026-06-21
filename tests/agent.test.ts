// tests/agent.test.ts
// regression tests for the agent tool-use loop

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Agent, type AgentEvents } from '../src/agent/agent.js'
import type { Tool, ToolExecutionContext } from '../src/tools/index.js'
import type { ChatRequest, OllamaMessage } from '../src/types/inference.js'
import { GIT_CONTEXT_HEADING } from '../src/agent/git-context.js'
import {
  estimateTotalTokens,
  FROZEN_SUMMARY_MARKER,
} from '../src/agent/compaction.js'

const tempDirs: string[] = []
const hasGit = spawnSync('git', ['--version']).status === 0

interface TestAgentOptions
{
  tools?: Tool[]
  registerSubagent?: boolean
  verifyEdits?: boolean
  maxIterations?: number
}

type TestChatStream = (request?: ChatRequest) => AsyncGenerator<{
  message: OllamaMessage
  done: boolean
}>

type TestAgent = Agent & {
  client: {
    startKeepAlive: (model: string) => void
    unloadModel?: (model?: string) => Promise<void>
    chatStream: TestChatStream
  }
  messages: OllamaMessage[]
}

type ReadOnlySubagentPatch = Agent & {
  runReadOnlySubagent: (prompt: string) => Promise<{
    text: string
    toolCount: number
    error?: string
    aborted: boolean
  }>
}

function createTestAgent(
  dir: string,
  options: TestAgentOptions = {},
  baseUrl = 'http://localhost:11434'
): TestAgent
{
  return new Agent('fake-model', baseUrl, dir, options) as TestAgent
}

function attachChatStream(agent: TestAgent, chatStream: TestChatStream): void
{
  agent.client = {
    startKeepAlive()
    {},
    chatStream,
  }
}

function createAgentEvents(overrides: Partial<AgentEvents> = {}): AgentEvents
{
  return {
    onToken()
    {},
    onToolCall()
    {},
    onToolResult()
    {},
    onToolApproval()
    {
      return Promise.resolve(true)
    },
    onDone()
    {},
    onError(error)
    {
      throw error
    },
    ...overrides,
  }
}

// remove temp workspaces created during tests
after(async () =>
{
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

test('Agent accumulates streamed tool calls, preserves thinking, & tags tool results', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-agent-'))
  tempDirs.push(dir)

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

  const agent = createTestAgent(dir)

  let streamCount = 0
  attachChatStream(agent, async function* ()
  {
    streamCount += 1

    if (streamCount === 1)
    {
      yield {
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
      }

      yield {
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
      }

      return
    }

    yield {
      message: {
        role: 'assistant',
        content: 'done',
      },
      done: true,
    }
  })

  const seenCalls: string[] = []
  const seenResults: string[] = []
  const seenThinking: string[] = []

  await agent.run(
    'inspect the repo',
    createAgentEvents({
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
  { skip: !hasGit },
  async () =>
  {
    const dir = await mkdtemp(join(tmpdir(), 'coral-git-context-agent-'))
    tempDirs.push(dir)
    assert.equal(spawnSync('git', ['init'], { cwd: dir }).status, 0)
    assert.equal(
      spawnSync('git', ['config', 'user.email', 'test@coral.dev'], {
        cwd: dir,
      }).status,
      0
    )
    assert.equal(
      spawnSync('git', ['config', 'user.name', 'Coral Test'], { cwd: dir })
        .status,
      0
    )
    await writeFile(join(dir, 'note.txt'), 'hello\n', 'utf-8')
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: dir }).status, 0)
    assert.equal(
      spawnSync('git', ['commit', '-m', 'init'], { cwd: dir }).status,
      0
    )

    const agent = createTestAgent(dir)
    const requests: OllamaMessage[][] = []
    const contextTokens: number[] = []

    attachChatStream(agent, async function* (request)
    {
      requests.push(request?.messages ?? [])
      yield {
        message: { role: 'assistant', content: 'ok' },
        done: true,
      }
    })

    await agent.run(
      'first',
      createAgentEvents({
        onUsage(usage)
        {
          contextTokens.push(usage.contextTokens)
        },
      })
    )
    await agent.run(
      'second',
      createAgentEvents({
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
  const dir = await mkdtemp(join(tmpdir(), 'coral-frozen-prefix-'))
  tempDirs.push(dir)

  const agent = createTestAgent(dir)
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
  const dir = await mkdtemp(join(tmpdir(), 'coral-parallel-contract-'))
  tempDirs.push(dir)

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

    const agent = createTestAgent(dir, {
      tools: [tool],
      registerSubagent: false,
      verifyEdits: false,
    })

    let streamCount = 0
    attachChatStream(agent, async function* ()
    {
      streamCount += 1

      if (streamCount === 1)
      {
        yield {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { type: 'function', function: { name, arguments: {} } },
              { type: 'function', function: { name, arguments: {} } },
            ],
          },
          done: true,
        }

        return
      }

      yield {
        message: {
          role: 'assistant',
          content: 'done',
        },
        done: true,
      }
    })

    await agent.run('run two tools', createAgentEvents())

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
  const dir = await mkdtemp(join(tmpdir(), 'coral-tool-context-'))
  tempDirs.push(dir)

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

  const agent = createTestAgent(
    dir,
    {
      tools: [tool],
      registerSubagent: false,
      verifyEdits: false,
    },
    'http://ollama-a.test'
  )

  let streamCount = 0
  attachChatStream(agent, async function* ()
  {
    streamCount += 1

    if (streamCount === 1)
    {
      yield {
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
      }
      return
    }

    yield {
      message: {
        role: 'assistant',
        content: 'done',
      },
      done: true,
    }
  })

  const controller = new AbortController()

  await agent.run('run tool', createAgentEvents(), controller.signal)

  assert.equal(seenContext?.cwd, dir)
  assert.equal(seenContext?.ollamaHost, 'http://ollama-a.test')
  assert.equal(seenContext?.signal, controller.signal)
})

test('Agent verifies edit diffs recorded from tool results', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-verify-diff-'))
  tempDirs.push(dir)

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

  const agent = createTestAgent(dir, {
    tools: [tool],
    registerSubagent: false,
    verifyEdits: true,
  })

  let streamCount = 0
  attachChatStream(agent, async function* ()
  {
    streamCount += 1

    if (streamCount === 1)
    {
      yield {
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
      }
      return
    }

    yield {
      message: {
        role: 'assistant',
        content: 'done',
      },
      done: true,
    }
  })

  const prototype = Agent.prototype as unknown as ReadOnlySubagentPatch
  const originalRunReadOnlySubagent = prototype.runReadOnlySubagent
  let verifyPrompt = ''

  prototype.runReadOnlySubagent = async (prompt: string) =>
  {
    verifyPrompt = prompt
    return {
      text: 'VERDICT: FAIL - diff mismatch',
      toolCount: 0,
      aborted: false,
    }
  }

  try
  {
    const verdicts: string[] = []
    await agent.run(
      'apply the requested edit',
      createAgentEvents({
        onVerification(result)
        {
          verdicts.push(`${result.status}:${result.reason ?? ''}`)
        },
      })
    )

    assert.ok(verifyPrompt.includes('apply the requested edit'))
    assert.ok(verifyPrompt.includes('example.ts'))
    assert.deepEqual(verdicts, ['fail:diff mismatch'])
  }
  finally
  {
    prototype.runReadOnlySubagent = originalRunReadOnlySubagent
  }
})

test('Agent only asks approval for dangerous tools & records rejections as tool results', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-approval-'))
  tempDirs.push(dir)

  await writeFile(join(dir, 'note.txt'), 'hello from coral\n', 'utf-8')

  const agent = createTestAgent(dir)

  let streamCount = 0
  attachChatStream(agent, async function* ()
  {
    streamCount += 1

    if (streamCount === 1)
    {
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
      }

      return
    }

    yield {
      message: {
        role: 'assistant',
        content: 'done',
      },
      done: true,
    }
  })

  const approvals: string[] = []
  const results: string[] = []

  await agent.run(
    'inspect the repo',
    createAgentEvents({
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
  const dir = await mkdtemp(join(tmpdir(), 'coral-abort-'))
  tempDirs.push(dir)
  await writeFile(join(dir, 'note.txt'), 'hello\n', 'utf-8')

  const agent = createTestAgent(dir)

  attachChatStream(agent, async function* ()
  {
    yield {
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
    }
  })

  // abort while the approval-gated bash call is pending, mid-batch
  const controller = new AbortController()

  await agent.run(
    'go',
    createAgentEvents({
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
  const dir = await mkdtemp(join(tmpdir(), 'coral-maxiter-'))
  tempDirs.push(dir)

  const agent = createTestAgent(dir, {
    maxIterations: 3,
  })

  // a model that always asks for one more unknown tool; w/o the cap the
  // loop would never terminate
  let streamCount = 0
  attachChatStream(agent, async function* ()
  {
    streamCount += 1
    yield {
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
    }
  })

  let done = false
  await agent.run(
    'loop forever',
    createAgentEvents({
      onDone()
      {
        done = true
      },
    })
  )

  assert.equal(done, true)
  assert.equal(streamCount, 3)
})
