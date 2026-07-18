// tests/agent/agent.test.ts
// regression tests for the agent tool-use loop

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Agent, type AgentMcpManager } from '../../src/agent/agent.js'
import {
  estimateOllamaToolTokens,
  type Tool,
  type ToolExecutionContext,
} from '../../src/tools/index.js'
import { AgentTodoState } from '../../src/agent/todo-state.js'
import {
  type ChatRequest,
  type OllamaMessage,
} from '../../src/types/inference.js'
import type { TodoItem } from '../../src/types/todo.js'
import { GIT_CONTEXT_HEADING } from '../../src/agent/git-context.js'
import type { CodeIntelService } from '../../src/lsp/client.js'
import {
  estimateTotalTokens,
  FROZEN_SUMMARY_MARKER,
} from '../../src/agent/compaction.js'
import { estimateRequestFramingTokens } from '../../src/agent/request-budget.js'
import { TEXT_FILE_READ_LIMIT_BYTES } from '../../src/utils/file-read.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { HAS_GIT, initTestRepo } from '../helpers/git.js'
import {
  makeFakeAgent,
  makeAgentEvents,
  type FakeChunk,
} from '../helpers/agent-harness.js'

const { tempDir } = makeTempDirPool()

type LifecycleAgent = Agent & {
  codeIntel: CodeIntelService & {
    child?: {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
    }
  }
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

  const assistantToolTurn = agent
    .getMessages()
    .find((message) => message.tool_calls?.length === 2)
  assert.ok(assistantToolTurn)
  assert.equal(
    assistantToolTurn.thinking,
    'Inspect files. Then read package metadata.'
  )
  assert.deepEqual(
    assistantToolTurn.tool_calls?.map((call) => call.function.name),
    ['read_file', 'glob']
  )

  const toolMessages = agent
    .getMessages()
    .filter((message) => message.role === 'tool')
  assert.equal(toolMessages.length, 2)
  assert.deepEqual(
    toolMessages.map((message) => message.tool_name),
    ['read_file', 'glob']
  )
})

test('Agent undo and redo restore a tool-use turn with file edits', async () =>
{
  const dir = await tempDir('coral-agent-undo-')
  const target = join(dir, 'created.txt')
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
                index: 0,
                name: 'write_file',
                arguments: { path: 'created.txt', content: 'hello\n' },
              },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ])

  await agent.run('create a file', makeAgentEvents())
  const messageCount = agent.getMessageCount()

  assert.equal(await readFile(target, 'utf-8'), 'hello\n')
  assert.ok(messageCount > 0)

  const controller = new AbortController()
  const canceledUndo = agent.undoLastTurn(controller.signal)
  controller.abort()
  const canceled = await canceledUndo
  assert.equal(canceled.ok, false)
  assert.equal(await readFile(target, 'utf-8'), 'hello\n')
  assert.equal(agent.getMessageCount(), messageCount)

  const undo = await agent.undoLastTurn()

  assert.equal(undo.ok, true)
  assert.equal(existsSync(target), false)
  assert.equal(agent.getMessageCount(), 0)

  const redo = await agent.redoLastTurn()

  assert.equal(redo.ok, true)
  assert.equal(await readFile(target, 'utf-8'), 'hello\n')
  assert.equal(agent.getMessageCount(), messageCount)
})

test('Agent undo and redo restore edited and created files together', async () =>
{
  const dir = await tempDir('coral-agent-undo-multi-')
  const edited = join(dir, 'edited.txt')
  const created = join(dir, 'created.txt')
  await writeFile(edited, 'old\n', 'utf-8')
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
                index: 0,
                name: 'write_file',
                arguments: { path: 'edited.txt', content: 'new\n' },
              },
            },
            {
              type: 'function',
              function: {
                index: 1,
                name: 'write_file',
                arguments: { path: 'created.txt', content: 'created\n' },
              },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ])

  await agent.run('edit and create files', makeAgentEvents())
  const messageCount = agent.getMessageCount()

  assert.equal(await readFile(edited, 'utf-8'), 'new\n')
  assert.equal(await readFile(created, 'utf-8'), 'created\n')

  const undo = await agent.undoLastTurn()

  assert.equal(undo.ok, true)
  assert.equal(await readFile(edited, 'utf-8'), 'old\n')
  assert.equal(existsSync(created), false)
  assert.equal(agent.getMessageCount(), 0)

  const redo = await agent.redoLastTurn()

  assert.equal(redo.ok, true)
  assert.equal(await readFile(edited, 'utf-8'), 'new\n')
  assert.equal(await readFile(created, 'utf-8'), 'created\n')
  assert.equal(agent.getMessageCount(), messageCount)
})

test('Agent failed undo leaves files, history, and stacks unchanged', async () =>
{
  const dir = await tempDir('coral-agent-undo-fail-')
  const target = join(dir, 'target.txt')
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
                index: 0,
                name: 'write_file',
                arguments: { path: 'target.txt', content: 'coral\n' },
              },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ])

  await agent.run('write a file', makeAgentEvents())
  const messages = agent.getMessages()
  const undoStack = agent.getUndoStack()
  const redoStack = agent.getRedoStack()
  await writeFile(target, 'external\n', 'utf-8')

  const undo = await agent.undoLastTurn()

  assert.equal(undo.ok, false)
  assert.match(undo.message, /changed outside Coral/)
  assert.equal(await readFile(target, 'utf-8'), 'external\n')
  assert.deepEqual(agent.getMessages(), messages)
  assert.deepEqual(agent.getUndoStack(), undoStack)
  assert.deepEqual(agent.getRedoStack(), redoStack)
})

test('Agent restored undo and redo stacks mutate disk after resume', async () =>
{
  const dir = await tempDir('coral-agent-undo-resume-')
  const target = join(dir, 'created.txt')
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
                index: 0,
                name: 'write_file',
                arguments: { path: 'created.txt', content: 'hello\n' },
              },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ])

  await agent.run('create a file', makeAgentEvents())
  const messages = agent.getMessages()
  const undoStack = agent.getUndoStack()
  const resumed = makeFakeAgent(dir, [[]]).agent
  resumed.restoreMessages(messages)
  resumed.restoreUndoStack(undoStack)

  const undo = await resumed.undoLastTurn()

  assert.equal(undo.ok, true)
  assert.equal(existsSync(target), false)

  const redo = await resumed.redoLastTurn()

  assert.equal(redo.ok, true)
  assert.equal(await readFile(target, 'utf-8'), 'hello\n')
})

test('Agent clears redo after a divergent turn', async () =>
{
  const dir = await tempDir('coral-agent-redo-clear-')
  const target = join(dir, 'created.txt')
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
                index: 0,
                name: 'write_file',
                arguments: { path: 'created.txt', content: 'old\n' },
              },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
    [{ message: { role: 'assistant', content: 'different done' }, done: true }],
  ])

  await agent.run('create old file', makeAgentEvents())
  const undo = await agent.undoLastTurn()
  assert.equal(undo.ok, true)
  assert.equal(existsSync(target), false)

  await agent.run('do something different', makeAgentEvents())
  const redo = await agent.redoLastTurn()

  assert.equal(redo.ok, false)
  assert.match(redo.message, /Nothing to redo/)
  assert.equal(existsSync(target), false)
})

test('Agent records undo when a later stream errors after a write', async () =>
{
  const dir = await tempDir('coral-agent-stream-err-')
  const target = join(dir, 'created.txt')
  let streamCalls = 0
  const { agent } = makeFakeAgent(dir, async function* (request)
  {
    // leave tool-less summary requests empty so this reaches the trim fallback
    if (!request?.tools?.length) return

    streamCalls += 1
    if (streamCalls === 1)
    {
      yield {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              type: 'function',
              function: {
                index: 0,
                name: 'write_file',
                arguments: { path: 'created.txt', content: 'hello\n' },
              },
            },
          ],
        },
        done: true,
      }
      return
    }
    throw new Error('ollama disconnected')
  })

  let seenError: Error | undefined
  let doneCalls = 0
  let errorCalls = 0
  await agent.run(
    'create a file',
    makeAgentEvents({
      onDone()
      {
        doneCalls++
      },
      onError(error)
      {
        errorCalls++
        seenError = error
      },
    })
  )

  assert.equal(doneCalls, 0)
  assert.equal(errorCalls, 1)
  assert.match(seenError?.message ?? '', /ollama disconnected/)
  assert.equal(await readFile(target, 'utf-8'), 'hello\n')
  assert.ok(agent.getUndoStack().length >= 1)

  const undo = await agent.undoLastTurn()
  assert.equal(undo.ok, true)
  assert.equal(existsSync(target), false)
})

test('a throwing tool-result callback releases the turn after recording its mutation', async () =>
{
  const dir = await tempDir('coral-agent-callback-failure-')
  const target = join(dir, 'created.txt')
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
                index: 0,
                name: 'write_file',
                arguments: { path: 'created.txt', content: 'written\n' },
              },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'recovered' }, done: true }],
  ])

  await assert.rejects(
    agent.run(
      'write the file',
      makeAgentEvents({
        onToolResult()
        {
          throw new Error('tool-result view failed')
        },
      })
    ),
    /tool-result view failed/
  )

  assert.equal(await readFile(target, 'utf-8'), 'written\n')
  assert.equal(agent.getUndoStack().length, 1)

  let completed = false
  await agent.run(
    'continue after the view failure',
    makeAgentEvents({
      onDone()
      {
        completed = true
      },
    })
  )
  assert.equal(completed, true)
})

test('an old terminal callback cannot clear a reentrant next-turn anchor', async () =>
{
  const dir = await tempDir('coral-agent-terminal-reentry-')
  const parallelCalls = Array.from({ length: 100 }, (_, index) => ({
    type: 'function' as const,
    function: {
      index,
      name: `missing_tool_${index}`,
      arguments: {},
    },
  }))
  const { agent } = makeFakeAgent(
    dir,
    [
      [{ message: { role: 'assistant', content: 'first done' }, done: true }],
      [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: parallelCalls,
          },
          done: true,
        },
      ],
      [{ message: { role: 'assistant', content: 'second done' }, done: true }],
    ],
    { tools: [], numCtx: 65_536 }
  )

  let nextTurn: ReturnType<Agent['acceptTurn']> | undefined
  await assert.rejects(
    agent.run(
      'first',
      makeAgentEvents({
        onDone()
        {
          nextTurn = agent.acceptTurn('second')
          throw new Error('terminal view failed')
        },
      })
    ),
    /terminal view failed/
  )

  assert.ok(nextTurn)
  await agent.runAcceptedTurn(nextTurn, makeAgentEvents())
  const undo = await agent.undoLastTurn()
  assert.equal(undo.ok, true)
  assert.ok((undo.removedMessages ?? 0) > 100)
  assert.equal(
    agent.getMessages().some((message) => message.content === 'second'),
    false
  )
})

test('Agent compaction clears undo stacks', async () =>
{
  const dir = await tempDir('coral-agent-compact-undo-')
  const target = join(dir, 'created.txt')
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
                index: 0,
                name: 'write_file',
                arguments: { path: 'created.txt', content: 'hello\n' },
              },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
    [
      {
        message: {
          role: 'assistant',
          content: 'summary of prior work',
        },
        done: true,
      },
    ],
  ])

  await agent.run('create a file', makeAgentEvents())
  assert.ok(agent.getUndoStack().length >= 1)

  const compacted = await agent.forceCompact()
  assert.ok(compacted)
  assert.equal(agent.getUndoStack().length, 0)
  assert.equal(agent.getRedoStack().length, 0)

  const undo = await agent.undoLastTurn()
  assert.equal(undo.ok, false)
  assert.match(undo.message, /Nothing to undo/)
  assert.equal(await readFile(target, 'utf-8'), 'hello\n')
})

test('Agent mid-run trim preserves current-turn undo recording', async () =>
{
  const dir = await tempDir('coral-agent-mid-trim-')
  const target = join(dir, 'created.txt')
  // fill to MAX_HISTORY so the run's user push + tool loop trip mid-run trim
  const prior = Array.from({ length: 99 }, (_unused, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `prior ${index}`,
  }))
  let streamCalls = 0
  const { agent } = makeFakeAgent(
    dir,
    async function* ()
    {
      streamCalls += 1
      // many list_files rounds grow history past the live window
      if (streamCalls <= 40)
      {
        yield {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                type: 'function',
                function: {
                  index: 0,
                  name: 'list_files',
                  arguments: { path: '.' },
                },
              },
            ],
          },
          done: true,
        }
        return
      }
      if (streamCalls === 41)
      {
        yield {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                type: 'function',
                function: {
                  index: 0,
                  name: 'write_file',
                  arguments: { path: 'created.txt', content: 'kept\n' },
                },
              },
            ],
          },
          done: true,
        }
        return
      }
      yield {
        message: { role: 'assistant', content: 'done after trim' },
        done: true,
      }
    },
    { numCtx: 32_768 }
  )
  agent.restoreMessages([{ role: 'system', content: 'System' }, ...prior])
  agent.restoreUndoStack([
    {
      startIndex: 1,
      endIndex: 2,
      userMessage: 'prior',
      messages: [
        { role: 'user', content: 'prior' },
        { role: 'assistant', content: 'old' },
      ],
      changes: [],
    },
  ])

  await agent.run('create after trim', makeAgentEvents())

  assert.equal(await readFile(target, 'utf-8'), 'kept\n')
  const stack = agent.getUndoStack()
  assert.equal(stack.length, 1)
  assert.equal(stack[0]?.userMessage, 'create after trim')
  assert.equal(stack[0]?.changes.length, 1)
  assert.ok(agent.getMessages().some((m) => m.content === 'create after trim'))

  const undo = await agent.undoLastTurn()
  assert.equal(undo.ok, true)
  assert.equal(existsSync(target), false)
})

test('Agent refuses oversized write_file without disk mutation or undo capture', async () =>
{
  const dir = await tempDir('coral-agent-big-write-')
  const target = join(dir, 'huge.txt')
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
                index: 0,
                name: 'write_file',
                arguments: {
                  path: 'huge.txt',
                  content: 'q'.repeat(TEXT_FILE_READ_LIMIT_BYTES + 1),
                },
              },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'gave up' }, done: true }],
  ])

  await agent.run('write a huge file', makeAgentEvents())

  assert.equal(existsSync(target), false)
  const stack = agent.getUndoStack()
  assert.equal(stack.length, 1)
  assert.equal(stack[0]?.changes.length, 0)
})

test('Agent todo_write and undo/redo stay isolated per session', async () =>
{
  const firstDir = await tempDir('coral-agent-todo-first-')
  const secondDir = await tempDir('coral-agent-todo-second-')
  const firstBefore = [{ content: 'existing task', status: 'pending' as const }]
  const firstAfter = [{ content: 'new task', status: 'in_progress' as const }]
  const secondBefore = [
    { content: 'separate session', status: 'completed' as const },
  ]
  const secondAfter = [
    { content: 'other work', status: 'in_progress' as const },
  ]
  const todoScript = (todos: typeof firstAfter): FakeChunk[][] => [
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
                arguments: { todos },
              },
            },
          ],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ]
  const { agent: first } = makeFakeAgent(firstDir, todoScript(firstAfter), {
    todoState: new AgentTodoState(firstBefore),
  })
  const { agent: second } = makeFakeAgent(secondDir, todoScript(secondAfter), {
    todoState: new AgentTodoState(secondBefore),
  })
  let throwingNotifications = 0
  const observedFirstSnapshots: TodoItem[][] = []
  const detachThrowingSubscriber = first.subscribeTodos(() =>
  {
    throwingNotifications += 1
    throw new Error('subscriber failed')
  })
  const detachSnapshotSubscriber = first.subscribeTodos((todos) =>
  {
    observedFirstSnapshots.push(todos)
  })

  await first.run('update todos', makeAgentEvents())

  assert.deepEqual(first.getTodos(), firstAfter)
  assert.deepEqual(second.getTodos(), secondBefore)

  await second.run('update other todos', makeAgentEvents())

  assert.deepEqual(first.getTodos(), firstAfter)
  assert.deepEqual(second.getTodos(), secondAfter)

  const undo = await first.undoLastTurn()

  assert.equal(undo.ok, true)
  assert.deepEqual(first.getTodos(), firstBefore)
  assert.deepEqual(second.getTodos(), secondAfter)

  const redo = await first.redoLastTurn()

  assert.equal(redo.ok, true)
  assert.deepEqual(first.getTodos(), firstAfter)
  assert.deepEqual(second.getTodos(), secondAfter)
  assert.equal(throwingNotifications, 3)
  assert.deepEqual(observedFirstSnapshots, [
    firstAfter,
    firstBefore,
    firstAfter,
  ])

  detachThrowingSubscriber()
  detachSnapshotSubscriber()
  first.clearTodos()
  assert.equal(throwingNotifications, 3)
  assert.equal(observedFirstSnapshots.length, 3)
})

test('Agent stores displayContent without sending it to the model', async () =>
{
  const dir = await tempDir('coral-agent-display-content-')
  const displayPrompt = 'clean prompt'
  await writeFile(join(dir, 'context.txt'), 'attached file context\n', 'utf-8')
  let requestMessages: OllamaMessage[] = []
  const { agent } = makeFakeAgent(dir, async function* (request)
  {
    requestMessages = request?.messages ?? []
    yield { message: { role: 'assistant', content: 'done' }, done: true }
  })

  await agent.run(
    { content: displayPrompt, attachmentPaths: ['context.txt'] },
    makeAgentEvents()
  )

  const requestUser = requestMessages.find((message) => message.role === 'user')
  assert.match(requestUser?.content ?? '', /attached file context/)
  assert.equal(requestUser?.displayContent, undefined)
  assert.equal(agent.getMessages()[1]?.displayContent, displayPrompt)

  const undo = await agent.undoLastTurn()
  assert.equal(undo.ok, true)
  const redo = await agent.redoLastTurn()
  assert.equal(redo.ok, true)
  assert.equal(agent.getMessages()[1]?.displayContent, displayPrompt)
})

test('Agent.run keeps the accepted turn when context resolution aborts', async () =>
{
  const dir = await tempDir('coral-agent-context-abort-')
  const controller = new AbortController()
  let showStarted!: () => void
  const showStartedPromise = new Promise<void>((resolve) =>
  {
    showStarted = resolve
  })
  let seenSignal: AbortSignal | undefined
  const { agent, streams } = makeFakeAgent(
    dir,
    [[{ message: { role: 'assistant', content: 'done' }, done: true }]],
    {
      inferenceClient: {
        async showModel(_model: string, signal?: AbortSignal)
        {
          seenSignal = signal
          showStarted()
          await new Promise<void>((_resolve, reject) =>
          {
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true }
            )
          })
          return { contextLength: 8_192, architecture: 'gemma' }
        },
        async listModels()
        {
          return []
        },
      },
    }
  )

  const run = agent.run('hello', makeAgentEvents(), controller.signal)
  await showStartedPromise
  controller.abort()
  await run

  // caller cancellation stops this run, but the shared lookup belongs to the
  // Agent lifecycle so a later caller can still reuse it until model disposal
  assert.equal(seenSignal?.aborted, false)
  // the accepted turn is recorded before cancelable bootstrap so the visible
  // & persisted transcripts agree after a cancel; no model request ran
  assert.equal(agent.getMessageCount(), 1)
  const lastMessage = agent.getMessages().at(-1)
  assert.equal(lastMessage?.role, 'user')
  assert.equal(lastMessage?.content, 'hello')
  assert.equal(streams(), 0)

  // repeated disposal joins one cleanup promise
  const firstDispose = agent.dispose()
  assert.equal(agent.dispose(), firstDispose)
  assert.equal(seenSignal?.aborted, true)
  await firstDispose
})

test('Agent.dispose aborts & joins a run before owned LSP cleanup w/o eviction', async () =>
{
  const dir = await tempDir('coral-agent-dispose-lifecycle-')
  await writeFile(join(dir, 'example.ts'), 'const value = 1\n', 'utf-8')

  let streamStarted!: () => void
  const streamStartedPromise = new Promise<void>((resolve) =>
  {
    streamStarted = resolve
  })
  let abortObserved!: () => void
  const abortObservedPromise = new Promise<void>((resolve) =>
  {
    abortObserved = resolve
  })
  let releaseStream!: () => void
  const streamGate = new Promise<void>((resolve) =>
  {
    releaseStream = resolve
  })

  const { agent: testAgent } = makeFakeAgent(
    dir,
    async function* (_request, signal)
    {
      assert.ok(signal)
      streamStarted()
      await new Promise<void>((resolve) =>
      {
        const onAbort = () =>
        {
          abortObserved()
          resolve()
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      await streamGate
      if (!signal.aborted)
      {
        yield { message: { role: 'assistant', content: '' }, done: true }
      }
    },
    { numCtx: 8_192 }
  )
  const agent = testAgent as LifecycleAgent

  await agent.codeIntel.query({
    operation: 'hover',
    path: 'example.ts',
    line: 1,
    character: 7,
  })
  const languageServer = agent.codeIntel.child
  assert.ok(languageServer)
  assert.equal(languageServer.exitCode, null)
  assert.equal(languageServer.signalCode, null)

  let doneCalled = false
  const run = agent.run(
    'wait for shutdown',
    makeAgentEvents({
      onDone()
      {
        doneCalled = true
      },
    })
  )
  await streamStartedPromise

  const firstDispose = agent.dispose()
  assert.equal(agent.dispose(), firstDispose)
  await abortObservedPromise

  let disposeSettled = false
  void firstDispose.then(
    () =>
    {
      disposeSettled = true
    },
    () =>
    {
      disposeSettled = true
    }
  )
  await Promise.resolve()
  const settledBeforeRelease = disposeSettled
  const serverExitedBeforeRelease =
    languageServer.exitCode !== null || languageServer.signalCode !== null

  releaseStream()
  await Promise.all([run, firstDispose])

  assert.equal(settledBeforeRelease, false)
  assert.equal(serverExitedBeforeRelease, false)
  assert.equal(doneCalled, true)
  assert.ok(
    languageServer.exitCode !== null || languageServer.signalCode !== null
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

    const requests: ChatRequest[] = []
    const contextTokens: number[] = []

    // request-inspecting form: capture the messages sent each turn
    const { agent } = makeFakeAgent(dir, async function* (request)
    {
      assert.ok(request)
      requests.push(request)
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
    assert.deepEqual(
      contextTokens,
      requests.map(
        (request) =>
          estimateTotalTokens(request.messages) +
          estimateOllamaToolTokens(request.tools ?? []) +
          estimateRequestFramingTokens(request.messages.length)
      )
    )
    for (const request of requests)
    {
      const messages = request.messages
      assert.equal(
        messages.filter((message) =>
          message.content.startsWith(GIT_CONTEXT_HEADING)
        ).length,
        1
      )
    }
    assert.equal(
      agent
        .getMessages()
        .some((message) => message.content.startsWith(GIT_CONTEXT_HEADING)),
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
    estimateTotalTokens(agent.getMessages().slice(0, frozen.messages))
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
  assert.ok(seenContext?.signal)
  assert.equal(seenContext.signal.aborted, false)
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

test('Agent sizes project context from resolved num_ctx before requests', async () =>
{
  const dir = await tempDir('coral-context-budget-')
  await writeFile(join(dir, '.coral.md'), 'x'.repeat(6_000), 'utf-8')

  let systemPrompt = ''
  const { agent } = makeFakeAgent(
    dir,
    async function* (request)
    {
      systemPrompt = request?.messages[0]?.content ?? ''
      yield { message: { role: 'assistant', content: 'done' }, done: true }
    },
    {
      inferenceClient: {
        async showModel()
        {
          return { contextLength: 8_192, architecture: 'gemma' }
        },
        async listModels()
        {
          return [
            {
              name: 'fake-model',
              model: 'fake-model',
              size: 0,
              modified_at: '',
            },
          ]
        },
      },
    }
  )

  await agent.run('hello', makeAgentEvents())

  assert.match(systemPrompt, /Loaded Project Context/)
  assert.match(systemPrompt, /truncated to fit budget/)
  assert.ok(!systemPrompt.includes('x'.repeat(6_000)))
})

test('MCP bootstrap retries aborted and unresolved trust snapshots without partial tools', async () =>
{
  const dir = await tempDir('coral-mcp-bootstrap-retry-')
  const dynamicTool: Tool = {
    name: 'mcp__demo__ping',
    description: 'ping the demo server',
    parameters: { type: 'object', properties: {} },
    async execute()
    {
      return { output: 'pong' }
    },
  }
  const requestToolSets: string[][] = []
  let bootstrapStarted!: () => void
  const firstBootstrapStarted = new Promise<void>((resolve) =>
  {
    bootstrapStarted = resolve
  })
  let createdManagers = 0
  const disposedManagers: number[] = []
  let launchApprovals = 0
  const mcpManagerFactory = async (): Promise<AgentMcpManager> =>
  {
    const index = createdManagers++
    if (index === 0)
    {
      return {
        initialize({ signal })
        {
          bootstrapStarted()
          return new Promise<Tool[]>((resolve) =>
          {
            if (signal?.aborted)
            {
              resolve([])
              return
            }
            signal?.addEventListener('abort', () => resolve([]), { once: true })
          })
        },
        getStatus: () => ({
          configIssues: [],
          servers: [
            {
              alias: 'demo',
              state: 'stopped',
              configuredTools: ['ping'],
              availableTools: [],
              launchCwd: dir,
              passEnv: [],
            },
          ],
        }),
        async dispose()
        {
          disposedManagers.push(index)
        },
      }
    }

    if (index === 1)
    {
      return {
        async initialize()
        {
          return [dynamicTool]
        },
        getStatus: () => ({
          configIssues: [],
          servers: [
            {
              alias: 'ready',
              state: 'ready',
              configuredTools: ['ping'],
              availableTools: ['ping'],
              launchCwd: dir,
              passEnv: [],
            },
            {
              alias: 'pending',
              state: 'needs_trust',
              configuredTools: ['inspect'],
              availableTools: [],
              launchCwd: dir,
              passEnv: [],
            },
          ],
        }),
        async dispose()
        {
          disposedManagers.push(index)
        },
      }
    }

    return {
      async initialize({ onLaunchApproval })
      {
        assert.ok(onLaunchApproval)
        const approved = await onLaunchApproval({
          alias: 'demo',
          command: 'demo-server',
          executable: '/demo-server',
          args: [],
          launchCwd: dir,
          passEnv: [],
          enabledTools: ['ping'],
          fingerprint: 'demo-fingerprint',
        })
        assert.equal(approved, true)
        return [dynamicTool]
      },
      getStatus: () => ({
        configIssues: [],
        servers: [
          {
            alias: 'demo',
            state: 'ready',
            configuredTools: ['ping'],
            availableTools: ['ping'],
            launchCwd: dir,
            passEnv: [],
          },
        ],
      }),
      async dispose()
      {
        disposedManagers.push(index)
      },
    }
  }

  const { agent } = makeFakeAgent(
    dir,
    async function* (request)
    {
      requestToolSets.push(
        request?.tools?.map((tool) => tool.function.name) ?? []
      )
      yield { message: { role: 'assistant', content: 'done' }, done: true }
    },
    { mcp: true, numCtx: 8_192, mcpManagerFactory }
  )

  const controller = new AbortController()
  const abortedRun = agent.run(
    'cancel first bootstrap',
    makeAgentEvents(),
    controller.signal
  )
  await firstBootstrapStarted
  controller.abort()
  await abortedRun

  await agent.run('no approval surface yet', makeAgentEvents())
  await agent.run(
    'retry where approval is available',
    makeAgentEvents({
      onMcpLaunchApproval()
      {
        launchApprovals++
        return Promise.resolve(true)
      },
    })
  )

  assert.equal(createdManagers, 3)
  assert.deepEqual(disposedManagers, [0, 1])
  assert.equal(launchApprovals, 1)
  assert.equal(requestToolSets.length, 2)
  assert.equal(requestToolSets[0]?.includes(dynamicTool.name), false)
  assert.equal(requestToolSets[1]?.includes(dynamicTool.name), true)
  await agent.dispose()
})

test('Agent.switchModel adopts the new model without host eviction', async () =>
{
  const dir = await tempDir('coral-switch-order-')
  const trackedModels: string[] = []
  let requestedModel: string | undefined
  const { agent } = makeFakeAgent(
    dir,
    async function* (request)
    {
      requestedModel = request?.model
      yield { message: { role: 'assistant', content: 'done' }, done: true }
    },
    {
      inferenceClient: {
        startKeepAlive(model)
        {
          trackedModels.push(model)
        },
        async showModel()
        {
          return { contextLength: 8_192, architecture: 'gemma' }
        },
        async listModels()
        {
          return [
            {
              name: 'next-model',
              model: 'next-model',
              size: 0,
              modified_at: '',
            },
          ]
        },
      },
    }
  )

  await agent.switchModel('next-model')
  assert.equal(agent.getModel(), 'next-model')
  assert.deepEqual(trackedModels, ['fake-model', 'next-model'])

  // the next run targets the switched-in model, never the pre-switch one
  await agent.run('hello', makeAgentEvents())
  assert.equal(requestedModel, 'next-model')
})

test('an aborted model switch leaves the old model and counters authoritative', async () =>
{
  const dir = await tempDir('coral-switch-abort-')
  let retirementStarted!: () => void
  const retirementStartedPromise = new Promise<void>((resolve) =>
  {
    retirementStarted = resolve
  })
  let releaseRetirement = () =>
  {}
  const retirement = new Promise<void>((resolve) =>
  {
    releaseRetirement = resolve
  })
  let replacementBootstraps = 0
  let createdManagers = 0
  const mcpManagerFactory = async (): Promise<AgentMcpManager> =>
  {
    const index = createdManagers++
    return {
      async initialize()
      {
        if (index > 0) replacementBootstraps += 1
        return []
      },
      getStatus: () => ({ configIssues: [], servers: [] }),
      dispose()
      {
        if (index === 0)
        {
          retirementStarted()
          return retirement
        }
        return Promise.resolve()
      },
    }
  }
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
                function: {
                  index: 0,
                  name: 'READ_FILE',
                  arguments: { path: 'missing.txt' },
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { role: 'assistant', content: 'done' }, done: true }],
      [{ message: { role: 'assistant', content: 'still done' }, done: true }],
    ],
    { mcp: true, numCtx: 8_192, mcpManagerFactory }
  )
  await agent.run('install the initial manager', makeAgentEvents())
  assert.equal(agent.getReliabilityStats().nameRepairs, 1)

  const controller = new AbortController()
  const switching = agent.switchModel('next-model', controller.signal)
  await retirementStartedPromise
  controller.abort()
  releaseRetirement()
  await assert.rejects(switching, { name: 'AbortError' })

  assert.equal(agent.getModel(), 'fake-model')
  assert.equal(agent.getReliabilityStats().nameRepairs, 1)
  await agent.run('continue on the old model', makeAgentEvents())
  assert.equal(streams(), 3)
  assert.equal(replacementBootstraps, 1)
  await agent.dispose()
})

test('context lookup is retired on model switch and joined on disposal', async () =>
{
  const dir = await tempDir('coral-context-lifecycle-')
  const calls: string[] = []
  let nextAbortSeen = false
  let releaseNext = () =>
  {}

  const { agent } = makeFakeAgent(dir, [], {
    inferenceClient: {
      async showModel(model, signal)
      {
        calls.push(model)
        return new Promise((resolve, reject) =>
        {
          void resolve
          signal?.addEventListener(
            'abort',
            () =>
            {
              const error = new DOMException('Aborted', 'AbortError')
              if (model === 'next-model')
              {
                nextAbortSeen = true
                releaseNext = () => reject(error)
              }
              else
              {
                reject(error)
              }
            },
            { once: true }
          )
        })
      },
      async listModels()
      {
        return []
      },
    },
  })

  const oldLookup = agent.fetchContextWindow()
  const oldResult = assert.rejects(oldLookup, { name: 'AbortError' })
  const canceled = new AbortController()
  const canceledSwitch = agent.switchModel('canceled-model', canceled.signal)
  canceled.abort()
  await assert.rejects(canceledSwitch, { name: 'AbortError' })
  await oldResult
  assert.equal(agent.getModel(), 'fake-model')

  await agent.switchModel('next-model')

  const nextLookupA = agent.fetchContextWindow()
  const nextLookupB = agent.fetchContextWindow()
  const nextResults = Promise.allSettled([nextLookupA, nextLookupB])
  assert.deepEqual(calls, ['fake-model', 'next-model'])

  let disposalSettled = false
  const disposal = agent.dispose().then(() =>
  {
    disposalSettled = true
  })
  await Promise.resolve()
  assert.equal(nextAbortSeen, true)
  assert.equal(disposalSettled, false)

  releaseNext()
  await nextResults
  await disposal
  assert.equal(disposalSettled, true)
  assert.deepEqual(calls, ['fake-model', 'next-model'])
})

test('Agent disposal joins an in-flight MCP permission retirement', async () =>
{
  const dir = await tempDir('coral-mcp-retirement-')
  let releaseRetirement = () =>
  {}
  const retirement = new Promise<void>((resolve) =>
  {
    releaseRetirement = resolve
  })
  const { agent } = makeFakeAgent(
    dir,
    [[{ message: { role: 'assistant', content: 'done' }, done: true }]],
    {
      mcp: true,
      numCtx: 8_192,
      mcpManagerFactory: async () => ({
        async initialize()
        {
          return []
        },
        getStatus: () => ({ configIssues: [], servers: [] }),
        dispose: () => retirement,
      }),
    }
  )
  await agent.run('install the manager', makeAgentEvents())

  const permission = agent.setMcpEnabled(false)
  let disposalSettled = false
  const disposal = agent.dispose().then(() =>
  {
    disposalSettled = true
  })
  await Promise.resolve()
  assert.equal(disposalSettled, false)

  releaseRetirement()
  await Promise.all([permission, disposal])
  assert.equal(disposalSettled, true)
})

test('resetSessionMetrics clears every conversation-lineage counter', async () =>
{
  const dir = await tempDir('coral-session-metrics-')
  const { agent } = makeFakeAgent(
    dir,
    [
      [
        {
          message: { role: 'assistant', content: 'summary' },
          done: true,
        },
      ],
      [
        {
          message: { role: 'assistant', content: 'done' },
          done: true,
          prompt_eval_count: 42,
          eval_count: 3,
        },
      ],
    ],
    { numCtx: 8_192 }
  )
  agent.restoreMessages(
    Array.from({ length: 4 }, (_unused, index) => [
      { role: 'user' as const, content: `question ${index}` },
      { role: 'assistant' as const, content: `answer ${index}` },
    ]).flat()
  )
  assert.ok(await agent.forceCompact())
  await agent.run('record usage', makeAgentEvents())
  assert.equal(agent.getCompactionCount(), 1)
  assert.ok(agent.getLastCompactedAt())
  assert.equal(agent.getTokenUsage().promptTokens, 42)

  agent.resetSessionMetrics()

  assert.equal(agent.getCompactionCount(), 0)
  assert.equal(agent.getLastCompactedAt(), null)
  assert.equal(agent.getTokenUsage().promptTokens, 0)
})

test('Agent.forceCompact passes the abort signal to the summary request', async () =>
{
  const dir = await tempDir('coral-compact-abort-')
  const controller = new AbortController()
  let seenSignal: AbortSignal | undefined
  const { agent } = makeFakeAgent(dir, [], {
    inferenceClient: {
      async *chatStream(_request, signal)
      {
        seenSignal = signal
        controller.abort()
        if (!signal?.aborted)
        {
          yield { message: { role: 'assistant', content: '' }, done: true }
        }
      },
    },
  })
  agent.restoreMessages([
    { role: 'system', content: 'System' },
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'four' },
  ])

  const result = await agent.forceCompact(controller.signal)

  assert.equal(seenSignal, controller.signal)
  assert.equal(result, null)
})

test('Agent.run leaves history untouched when automatic compaction is aborted', async () =>
{
  const dir = await tempDir('coral-auto-compact-abort-')
  // use the smallest supported window, but enough restored history to cross
  // its prompt-limit threshold without tripping fixed-cost overflow first
  const controller = new AbortController()
  let streamCalls = 0
  const { agent } = makeFakeAgent(dir, [], {
    numCtx: 8_192,
    inferenceClient: {
      async *chatStream(_request, signal)
      {
        // first stream is the summary request — abort mid-stream
        streamCalls += 1
        controller.abort()
        yield {
          message: { role: 'assistant', content: 'partial' },
          done: false,
        }
        void signal
      },
    },
  })

  // 120 alternating turns -> over MAX_HISTORY (100), so a fallback trim would
  // visibly drop messages if the abort path failed to bail out
  agent.restoreMessages(
    Array.from({ length: 120 }, (_unused, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `msg ${index + 1} ${'x'.repeat(40)}`,
    }))
  )

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

test('Agent injects one read-only runner into task execution while borrowed LSP stays usable', async () =>
{
  const dir = await tempDir('coral-subagent-lifecycle-')
  let borrowedDisposals = 0
  let borrowedQueries = 0
  const borrowedCodeIntel: CodeIntelService = {
    async query()
    {
      borrowedQueries += 1
      return 'borrowed LSP is available'
    },
    async dispose()
    {
      borrowedDisposals += 1
    },
  }

  const subagentPrompts: string[] = []
  const { agent: parent, streams } = makeFakeAgent(
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
                  name: 'task',
                  arguments: { prompt: 'inspect the project' },
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { role: 'assistant', content: 'done' }, done: true }],
      [{ message: { role: 'assistant', content: 'still usable' }, done: true }],
    ],
    {
      codeIntel: borrowedCodeIntel,
      numCtx: 8_192,
      async readOnlySubagentRunner(prompt, signal)
      {
        assert.ok(signal)
        subagentPrompts.push(prompt)
        const text = await borrowedCodeIntel.query({
          operation: 'hover',
          path: 'example.ts',
          line: 1,
          character: 1,
        })
        return { text }
      },
    }
  )

  await parent.run('delegate the inspection', makeAgentEvents())

  assert.deepEqual(subagentPrompts, ['inspect the project'])
  assert.equal(streams(), 2)
  assert.equal(borrowedDisposals, 0)
  assert.equal(
    await borrowedCodeIntel.query({
      operation: 'hover',
      path: 'example.ts',
      line: 1,
      character: 1,
    }),
    'borrowed LSP is available'
  )

  await parent.run('parent still works', makeAgentEvents())
  assert.equal(streams(), 3)
  assert.equal(borrowedQueries, 2)
  await parent.dispose()
  assert.equal(borrowedDisposals, 0)
})

test('Agent verifies edit diffs recorded from tool results', async () =>
{
  const dir = await tempDir('coral-verify-diff-')
  let verifyPrompt = ''

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
    {
      tools: [tool],
      verifyEdits: true,
      async readOnlySubagentRunner(prompt)
      {
        verifyPrompt = prompt
        return {
          text: 'VERDICT: FAIL - diff mismatch',
          aborted: false,
        }
      },
    }
  )

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

  const bashToolMessage = agent
    .getMessages()
    .find((message) => message.role === 'tool' && message.tool_name === 'bash')
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
  const assistant = agent
    .getMessages()
    .find((message) => message.role === 'assistant' && message.tool_calls)
  assert.ok(assistant?.tool_calls)
  const toolReplies = agent
    .getMessages()
    .filter((message) => message.role === 'tool')
  assert.equal(toolReplies.length, assistant.tool_calls!.length)

  const bashReply = agent
    .getMessages()
    .find((message) => message.role === 'tool' && message.tool_name === 'bash')
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

test('Agent rejects an absent tool even when its exact policy allows it', async () =>
{
  const dir = await tempDir('coral-absent-tool-')
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
                  name: 'configured_but_absent',
                  arguments: {},
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { role: 'assistant', content: 'done' }, done: true }],
    ],
    {
      tools: [],
      permissions: { configured_but_absent: 'always_allow' },
      verifyEdits: false,
    }
  )

  const approvals: string[] = []
  const results: Array<{ name: string; error?: string }> = []
  await agent.run(
    'try the configured tool',
    makeAgentEvents({
      onToolApproval(name)
      {
        approvals.push(name)
        return Promise.resolve(true)
      },
      onToolResult(name, _result, error)
      {
        results.push({ name, error })
      },
    })
  )

  assert.deepEqual(approvals, [])
  assert.deepEqual(results, [
    {
      name: 'configured_but_absent',
      error: 'Unknown tool: configured_but_absent',
    },
  ])
})

test('Agent approval defaults fail closed for prototype-named active tools', async () =>
{
  const dir = await tempDir('coral-prototype-tool-')
  let executions = 0
  const prototypeNamedTool: Tool = {
    name: 'toString',
    description: 'Prototype-name fixture.',
    parameters: { type: 'object', properties: {} },
    async execute()
    {
      executions += 1
      return { output: 'executed' }
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
                function: { name: 'toString', arguments: {} },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { role: 'assistant', content: 'done' }, done: true }],
    ],
    { tools: [prototypeNamedTool], permissions: {}, verifyEdits: false }
  )

  const approvals: string[] = []
  await agent.run(
    'try the prototype-named tool',
    makeAgentEvents({
      onToolApproval(name)
      {
        approvals.push(name)
        return Promise.resolve(false)
      },
    })
  )

  assert.deepEqual(approvals, ['toString'])
  assert.equal(executions, 0)
})

test('Agent derives verification only from valid boolean project config', async () =>
{
  const malformedDir = await tempDir('coral-agent-verify-')
  const enabledDir = await tempDir('coral-agent-verify-')
  await writeFile(
    join(malformedDir, '.coral.json'),
    JSON.stringify({ verify: { enabled: 'false' } }),
    'utf-8'
  )
  await writeFile(
    join(enabledDir, '.coral.json'),
    JSON.stringify({ verify: { enabled: true } }),
    'utf-8'
  )

  const { agent: malformed } = makeFakeAgent(malformedDir, [], { tools: [] })
  const { agent: enabled } = makeFakeAgent(enabledDir, [], { tools: [] })
  try
  {
    assert.equal(malformed.getVerifyEdits(), false)
    assert.equal(typeof malformed.getVerifyEdits(), 'boolean')
    assert.equal(enabled.getVerifyEdits(), true)
  }
  finally
  {
    await Promise.all([malformed.dispose(), enabled.dispose()])
  }
})
