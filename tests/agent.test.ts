// tests/agent.test.ts
// regression tests for the agent tool-use loop

import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Agent } from '../src/agent/agent.js'
import type { OllamaMessage } from '../src/types/inference.js'

const tempDirs: string[] = []

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

  const agent = new Agent(
    'fake-model',
    'http://localhost:11434',
    dir
  ) as Agent & {
    client: {
      startKeepAlive: (model: string) => void
      unloadModel?: (model?: string) => Promise<void>
      chatStream: () => AsyncGenerator<{
        message: OllamaMessage
        done: boolean
      }>
    }
    messages: OllamaMessage[]
  }

  let streamCount = 0
  agent.client = {
    startKeepAlive()
    {},
    async *chatStream()
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
    },
  }

  const seenCalls: string[] = []
  const seenResults: string[] = []
  const seenThinking: string[] = []

  await agent.run('inspect the repo', {
    onThinking(thinking)
    {
      seenThinking.push(thinking)
    },
    onToken()
    {},
    onToolCall(name)
    {
      seenCalls.push(name)
    },
    onToolResult(name, result, error)
    {
      seenResults.push(`${name}:${error ?? result.split('\n')[0]}`)
    },
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
  })

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

test('Agent only asks approval for dangerous tools & records rejections as tool results', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-approval-'))
  tempDirs.push(dir)

  await writeFile(join(dir, 'note.txt'), 'hello from coral\n', 'utf-8')

  const agent = new Agent(
    'fake-model',
    'http://localhost:11434',
    dir
  ) as Agent & {
    client: {
      startKeepAlive: (model: string) => void
      unloadModel?: (model?: string) => Promise<void>
      chatStream: () => AsyncGenerator<{
        message: OllamaMessage
        done: boolean
      }>
    }
    messages: OllamaMessage[]
  }

  let streamCount = 0
  agent.client = {
    startKeepAlive()
    {},
    async *chatStream()
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
    },
  }

  const approvals: string[] = []
  const results: string[] = []

  await agent.run('inspect the repo', {
    onToken()
    {},
    onToolCall()
    {},
    onToolResult(name, result, error)
    {
      results.push(`${name}:${error ?? result.split('\n')[0]}`)
    },
    onToolApproval(name)
    {
      approvals.push(name)
      return Promise.resolve(false)
    },
    onDone()
    {},
    onError(error)
    {
      throw error
    },
  })

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

  const agent = new Agent(
    'fake-model',
    'http://localhost:11434',
    dir
  ) as Agent & {
    client: {
      startKeepAlive: (model: string) => void
      chatStream: () => AsyncGenerator<{
        message: OllamaMessage
        done: boolean
      }>
    }
    messages: OllamaMessage[]
  }

  agent.client = {
    startKeepAlive()
    {},
    async *chatStream()
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
    },
  }

  // abort while the approval-gated bash call is pending, mid-batch
  const controller = new AbortController()

  await agent.run(
    'go',
    {
      onToken()
      {},
      onToolCall()
      {},
      onToolResult()
      {},
      onToolApproval()
      {
        controller.abort()
        return new Promise<boolean>(() =>
        {})
      },
      onDone()
      {},
      onError(error)
      {
        throw error
      },
    },
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

  const agent = new Agent('fake-model', 'http://localhost:11434', dir, {
    maxIterations: 3,
  }) as Agent & {
    client: {
      startKeepAlive: (model: string) => void
      chatStream: () => AsyncGenerator<{
        message: OllamaMessage
        done: boolean
      }>
    }
  }

  // a model that always asks for one more (unknown) tool — without the cap the
  // loop would never terminate
  let streamCount = 0
  agent.client = {
    startKeepAlive()
    {},
    async *chatStream()
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
    },
  }

  let done = false
  await agent.run('loop forever', {
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
    {
      done = true
    },
    onError(error)
    {
      throw error
    },
  })

  assert.equal(done, true)
  assert.equal(streamCount, 3)
})
