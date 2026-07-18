// tests/tui/tui.test.ts
// tests for major TUI transcript behavior

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import stripAnsi from 'strip-ansi'
import {
  buildTranscriptLines,
  failPendingToolCalls,
  maxScrollOffset,
  sliceViewport,
  summarizeToolArgs,
} from '../../src/tui/transcript/transcript.js'
import type { OutputBlock } from '../../src/tui/transcript/types.js'
import { buildRestoredBlocks } from '../../src/tui/transcript/restored-blocks.js'
import {
  buildApprovalContent,
  buildMcpApprovalContent,
  renderPromptBox,
} from '../../src/tui/run/approval-box.js'
import {
  formatAutoCompactionResult,
  formatManualCompactionResult,
} from '../../src/tui/commands/conversation-output.js'
import {
  formatCliSessionList,
  formatTuiSessionList,
} from '../../src/tui/commands/session-output.js'
import {
  commandCompletions,
  commandInfos,
  dispatchCommand,
} from '../../src/tui/commands/registry.js'
import type { CommandContext } from '../../src/tui/commands/contracts.js'
import type { Agent, CompactionResult } from '../../src/agent/agent.js'
import type { IndexStore } from '../../src/retrieval/types.js'
import { createEmbeddingSpace } from '../../src/retrieval/embedding-space.js'
import { RetrievalBuildError } from '../../src/retrieval/build.js'
import { OllamaModelIdentityError } from '../../src/ollama/errors.js'
import { buildTodoPanel } from '../../src/tui/transcript/todo-panel.js'
import { AgentTodoState } from '../../src/agent/state/todos.js'
import { visibleWidth } from '../../src/tui/wrap.js'
import { makeFakeAgent } from '../helpers/agent-harness.js'
import { makeSessionMeta } from '../helpers/session.js'
import { makeTempDirPool } from '../helpers/temp.js'

function plain(lines: string | string[]): string
{
  return stripAnsi(Array.isArray(lines) ? lines.join('\n') : lines)
}

const { tempDir } = makeTempDirPool()

function makeCommandContext(
  agent: Partial<Agent>,
  output: OutputBlock[] = []
): CommandContext
{
  return {
    agent: agent as Agent,
    activeModel: 'test-model',
    host: 'http://localhost:11434',
    yolo: false,
    sessionLabelId: 'abcd1234',
    pushOutput: (...blocks) => output.push(...blocks),
    pushTerminalOutput: (...blocks) => output.push(...blocks),
    clearSession()
    {},
    rebuildTranscript()
    {},
    resetTokenUsage()
    {},
    reopenModelPicker()
    {},
    switchModel: async () => ({ status: 'unchanged' }),
    getCwd: () => '/tmp/project',
    setYolo()
    {},
    exitApp()
    {},
    resumeSession: () => false,
    saveCurrentSession: () => ({ status: 'saved', id: 'abcd1234' }),
    renameCurrentSession: () => false,
    notifyThemeChanged()
    {},
  }
}

test('command registry preserves order, aliases, help, and dispatch', async () =>
{
  const expectedOrder = [
    'help',
    'clear',
    'compact',
    'status',
    'mcp',
    'model',
    'permissions',
    'verify',
    'theme',
    'undo',
    'redo',
    'diff',
    'copy',
    'todo',
    'index',
    'sessions',
    'resume',
    'rename',
    'new',
    'telemetry',
    'exit',
  ]
  const infos = commandInfos()

  assert.deepEqual(
    infos.map((command) => command.name),
    expectedOrder
  )
  assert.deepEqual(commandCompletions(), infos)
  assert.deepEqual(
    Object.fromEntries(
      infos
        .filter((command) => command.aliases.length > 0)
        .map((command) => [command.name, command.aliases])
    ),
    {
      clear: ['reset'],
      permissions: ['perm', 'perms'],
      sessions: ['ls'],
      exit: ['quit'],
    }
  )

  const output: OutputBlock[] = []
  let clears = 0
  const context = makeCommandContext(
    {
      clearHistory()
      {
        clears++
        return 1
      },
    },
    output
  )
  assert.equal(await dispatchCommand('/help', context), true)
  const help = plain(output.map((block) => block.content))
  let previous = -1
  for (const name of expectedOrder)
  {
    const position = help.indexOf(`/${name}`, previous + 1)
    assert.ok(position > previous, `/${name} is out of help order`)
    previous = position
  }

  assert.equal(await dispatchCommand('/RESET', context), true)
  assert.equal(clears, 1)
})

test('buildTranscriptLines renders conversation and tool results in scrollable order', () =>
{
  const blocks: OutputBlock[] = [
    { type: 'user', content: 'inspect src/agent/agent.ts' },
    { type: 'thinking', content: 'Inspect the prompt and tool flow first.' },
    { type: 'assistant', content: '## Findings\n\n- approval flow exists' },
    {
      type: 'tool_call',
      toolName: 'read_file',
      args: { path: 'src/agent/agent.ts' },
      status: 'success',
      duration: 200,
    },
    {
      type: 'tool_result',
      toolName: 'read_file',
      content: 'file contents here',
    },
  ]

  const lines = buildTranscriptLines({ blocks, streaming: '', width: 60 }).map(
    (line) => stripAnsi(line)
  )
  const viewportHeight = 5
  const liveViewport = sliceViewport(lines, viewportHeight, 0)
  const topViewport = sliceViewport(
    lines,
    viewportHeight,
    maxScrollOffset(lines.length, viewportHeight)
  )

  assert.ok(lines.some((line) => line.includes('inspect src/agent/agent.ts')))
  assert.ok(lines.some((line) => line.includes('approval flow exists')))
  assert.ok(lines.some((line) => line.includes('file contents here')))
  assert.equal(topViewport[0], lines[0])
  assert.equal(liveViewport.at(-1), lines.at(-1))
})

test('terminal cleanup fails pending tool calls and preserves their elapsed duration', () =>
{
  const pending: OutputBlock = {
    type: 'tool_call',
    toolName: 'read_file',
    args: { path: 'src/agent/agent.ts' },
    callId: 7,
  }
  const completed: OutputBlock = {
    type: 'tool_call',
    toolName: 'glob',
    args: { pattern: '**/*.ts' },
    callId: 8,
    status: 'success',
    duration: 25,
  }
  const olderPending: OutputBlock = {
    type: 'tool_call',
    toolName: 'grep',
    args: { pattern: 'stale' },
    callId: 99,
  }

  const blocks = failPendingToolCalls(
    [olderPending, pending, completed],
    new Map([[7, 1_000]]),
    1_450
  )

  assert.equal(blocks[0], olderPending)
  assert.deepEqual(blocks[1], {
    ...pending,
    status: 'error',
    duration: 450,
  })
  assert.equal(blocks[2], completed)
  assert.equal((pending as { status?: string }).status, undefined)
})

test('buildRestoredBlocks uses displayContent for restored user messages', () =>
{
  const blocks = buildRestoredBlocks([
    { role: 'system', content: 'System' },
    {
      role: 'user',
      content: 'clean prompt\n\n<attached file context>',
      displayContent: 'clean prompt',
    },
    { role: 'assistant', content: 'done' },
  ])

  assert.deepEqual(blocks[0], { type: 'user', content: 'clean prompt' })
  assert.equal(
    blocks.some(
      (block) =>
        block.type === 'user' && block.content.includes('attached file context')
    ),
    false
  )
})

test('buildTranscriptLines hides saved reasoning while preserving a live hint', () =>
{
  const blocks: OutputBlock[] = [
    { type: 'thinking', content: 'Read the repo before answering.' },
    { type: 'assistant', content: 'Ready.' },
  ]

  const hiddenLines = buildTranscriptLines({
    blocks,
    streaming: '',
    width: 60,
    showThinking: false,
  }).map((line) => stripAnsi(line))
  const liveHiddenLines = buildTranscriptLines({
    blocks: [],
    streaming: '',
    width: 60,
    streamingThinking: 'Inspecting files',
    showThinking: false,
  }).map((line) => stripAnsi(line))

  assert.ok(
    !hiddenLines.some((line) =>
      line.includes('Read the repo before answering.')
    )
  )
  assert.ok(hiddenLines.some((line) => line.includes('Ready.')))
  assert.ok(liveHiddenLines.some((line) => line.includes('Thinking')))
  assert.ok(liveHiddenLines.some((line) => line.includes('ctrl+t to show')))
})

test('buildTranscriptLines neutralizes untrusted terminal control sequences', () =>
{
  const blocks: OutputBlock[] = [
    { type: 'assistant', content: 'hello \x1b]52;c;AAAA\x07 world' },
    { type: 'system', content: 'system\x1b]52;c;CCCC\x07 note\x1b[2J' },
    {
      type: 'tool_result',
      toolName: 'read_file',
      content: 'before\x1b[2Jafter',
    },
    { type: 'diff', unified: '@@ -1,1 +1,1 @@\n-\x1b[2Jold\n+new' },
    {
      type: 'tool_call',
      toolName: 'hostile',
      args: {},
      display: {
        label: 'Unsafe\x1b]52;c;LABEL\x07 label',
        summary: 'bad\x1b[2Jsummary',
        mcp: false,
      },
    },
    {
      type: 'tool_call',
      toolName: 'settled_hostile',
      args: { raw: 'completed-summary-must-not-fall-back' },
      status: 'success',
      display: {
        label: 'Settled\x1b]52;c;LABEL\x07 label',
        summary: 'settled\x1b[2Jsummary',
        mcp: false,
      },
    },
  ]

  const rendered = buildTranscriptLines({
    blocks,
    streaming: 'live\x1b]52;c;BBBB\x07 text',
    width: 80,
  }).join('\n')

  assert.ok(!rendered.includes('\x1b]52'))
  assert.ok(!rendered.includes('\x1b[2J'))
  assert.ok(!plain(rendered).includes('\x07'))
  assert.ok(plain(rendered).includes('hello  world'))
  assert.ok(plain(rendered).includes('system note'))
  assert.ok(plain(rendered).includes('beforeafter'))
  assert.ok(plain(rendered).includes('Unsafe label'))
  assert.ok(plain(rendered).includes('badsummary'))
  assert.ok(plain(rendered).includes('Settled label'))
  assert.ok(plain(rendered).includes('settledsummary'))
  assert.ok(!plain(rendered).includes('completed-summary-must-not-fall-back'))

  assert.equal(
    summarizeToolArgs({ path: 'legacy.ts' }, { label: 'Legacy', mcp: false }),
    '{"path":"legacy.ts"}'
  )
  const cyclic: Record<string, unknown> = { count: 1n }
  cyclic.self = cyclic
  assert.match(summarizeToolArgs(cyclic), /BigInt.*Circular/)
})

test('buildTranscriptLines keeps app SGR styling in system blocks but strips controls', () =>
{
  const rendered = buildTranscriptLines({
    blocks: [
      {
        type: 'system',
        content: 'plain \x1b[36mcolored\x1b[39m end\x1b[2J\x1b]52;c;DDDD\x07',
      },
    ],
    width: 80,
  }).join('\n')

  // SGR color codes from app formatters survive
  assert.ok(rendered.includes('\x1b[36m'))
  assert.ok(rendered.includes('\x1b[39m'))
  // dangerous screen/clipboard controls are removed
  assert.ok(!rendered.includes('\x1b[2J'))
  assert.ok(!rendered.includes('\x1b]52'))
  assert.ok(plain(rendered).includes('plain colored end'))
})

test('buildTranscriptLines leaves streaming markdown unparsed until finalized', () =>
{
  const rendered = plain(
    buildTranscriptLines({
      blocks: [],
      streaming: '## Live\n\n```ts\nconst value = 1\n```',
      width: 80,
    })
  )

  assert.ok(rendered.includes('## Live'))
  assert.ok(rendered.includes('```ts'))
  assert.ok(rendered.includes('const value = 1'))
})

test('session list formatters sanitize session identifiers and models', () =>
{
  const sessions = [
    makeSessionMeta({
      id: 'abcd1234\x1b[2J',
      model: 'test-model\x1b]52;c;AAAA\x07',
      title: 'Unsafe\x1b[2J title',
    }),
  ]
  const cli = formatCliSessionList(sessions)
  const tui = formatTuiSessionList(sessions, null)

  assert.ok(!cli.includes('\x1b[2J'))
  assert.ok(!cli.includes('\x1b]52'))
  assert.ok(!tui.includes('\x1b[2J'))
  assert.ok(!tui.includes('\x1b]52'))
  assert.ok(plain(cli).includes('abcd1234  test-model'))
  assert.ok(plain(tui).includes('abcd1234  test-model'))
})

test('compaction formatters clear undo history only for summarized results', () =>
{
  const compacted: CompactionResult = {
    type: 'summarized',
    beforeMessages: 8,
    afterMessages: 4,
    beforeTokens: 900,
    afterTokens: 300,
  }
  const pruned: CompactionResult = {
    type: 'pruned',
    beforeMessages: 8,
    afterMessages: 8,
    beforeTokens: 1200,
    afterTokens: 800,
    prunedResults: 2,
  }

  assert.ok(
    plain(formatManualCompactionResult(compacted)).includes(
      'Undo history cleared'
    )
  )
  assert.ok(
    !plain(formatAutoCompactionResult(pruned)).includes('Undo history cleared')
  )
  assert.ok(
    plain(formatAutoCompactionResult(compacted)).includes(
      'Undo history cleared'
    )
  )
})

test('approval and confirm boxes share framed prompt rendering', () =>
{
  const render = (content: ReturnType<typeof buildApprovalContent>) =>
    plain(renderPromptBox(content, 50, 200, 0).lines)

  const longCommand = `${'x'.repeat(100)} important-tail`
  const longApproval = render(
    buildApprovalContent(
      'bash',
      { command: longCommand },
      50,
      undefined,
      undefined,
      { label: 'Shell', summary: longCommand, mcp: false }
    )
  )
  assert.ok(longApproval.includes('important-tail'))

  const hostileTitle = render(
    buildApprovalContent('unsafe\x1b[2J\nname', {}, 50, undefined, undefined, {
      label: 'Friendly',
      summary: '',
      mcp: false,
    })
  )
  assert.ok(!hostileTitle.includes('\x1b[2J'))
  assert.ok(hostileTitle.includes('Allow unsafe name?'))

  // full MCP launch identity must stay inspectable before trust persists
  const mcpContent = buildMcpApprovalContent(
    {
      alias: 'fixture',
      command: 'node',
      executable: '/usr/local/bin/node',
      args: ['server.js', '--flag'],
      launchCwd: '/home/user',
      passEnv: ['API_TOKEN_NAME'],
      enabledTools: ['echo'],
      fingerprint: 'f'.repeat(64),
    },
    80
  )
  const mcp = plain(renderPromptBox(mcpContent, 80, 200, 0).lines)
  assert.ok(mcp.includes('Resolved executable: /usr/local/bin/node'))
  assert.ok(mcp.includes('Arguments: ["server.js","--flag"]'))
  assert.ok(mcp.includes('Forwarded environment names: API_TOKEN_NAME'))
  // the fingerprint hard-wraps across rows; compare w/o frame & whitespace
  assert.ok(mcp.replace(/[\s│]/g, '').includes(`Fingerprint:${'f'.repeat(64)}`))

  // a bounded viewport pins title & actions while the body scrolls; the MCP
  // raw-JSON format follows the presentation snapshot, not name sniffing
  const long = buildApprovalContent(
    'mcp__fixture__echo',
    { text: 'x'.repeat(4_000) },
    50,
    undefined,
    undefined,
    { label: 'MCP · fixture · echo', mcp: true }
  )
  const bounded = renderPromptBox(long, 50, 16, 0)
  assert.ok(bounded.lines.length <= 16)
  assert.ok(bounded.maxOffset > 0)
  const boundedText = plain(bounded.lines)
  assert.ok(boundedText.includes('Allow mcp__fixture__echo?'))
  assert.match(boundedText, /lines 1-\d+ of \d+/)
  const scrolled = plain(renderPromptBox(long, 50, 16, bounded.maxOffset).lines)
  assert.match(scrolled, new RegExp(`of \\d+`))
  assert.notEqual(boundedText, scrolled)

  // legal narrow geometry stays inside both hard viewport dimensions
  const narrow = buildMcpApprovalContent(
    {
      alias: 'a'.repeat(32),
      command: 'node',
      executable: '/usr/local/bin/node',
      args: ['x'.repeat(4_096)],
      launchCwd: '/home/user',
      passEnv: [],
      enabledTools: ['t'.repeat(128)],
      fingerprint: 'f'.repeat(64),
    },
    20
  )
  const narrowTop = renderPromptBox(narrow, 20, 10, 0)
  assert.ok(narrowTop.lines.length <= 10)
  assert.ok(narrowTop.lines.every((line) => visibleWidth(line) <= 20))
  assert.ok(narrowTop.maxOffset > 0)
  const fingerprintReachable = Array.from(
    { length: narrowTop.maxOffset + 1 },
    (_, offset) => plain(renderPromptBox(narrow, 20, 10, offset).lines)
  ).some((rendered) => rendered.includes('f'.repeat(8)))
  assert.equal(fingerprintReachable, true)
})

test('todo panel and commands follow the active Agent session lifecycle', async () =>
{
  const initialTodos = [
    { content: 'inspect state', status: 'in_progress' as const },
    { content: 'finish handoff', status: 'pending' as const },
  ]
  const state = new AgentTodoState(initialTodos)
  const output: OutputBlock[] = []
  let historyClears = 0
  const agent: Partial<Agent> = {
    getTodos: () => state.snapshot(),
    clearTodos: () => state.clear(),
    clearHistory: () =>
    {
      historyClears += 1
      return 2
    },
  }
  const context = makeCommandContext(agent, output)
  const savedSnapshots: ReturnType<typeof state.snapshot>[] = []
  context.saveCurrentSession = () =>
  {
    savedSnapshots.push(state.snapshot())
    return { status: 'saved', id: 'abcd1234' }
  }
  context.clearSession = () => state.clear()

  assert.match(plain(buildTodoPanel(state.snapshot(), 48)), /inspect state/)
  assert.equal(await dispatchCommand('/todo', context), true)
  const viewed = output.at(-1)
  assert.equal(viewed?.type, 'system')
  if (viewed?.type === 'system')
  {
    assert.match(plain(viewed.content), /inspect state/)
    assert.match(plain(viewed.content), /finish handoff/)
  }

  assert.equal(await dispatchCommand('/todo clear', context), true)
  assert.deepEqual(state.snapshot(), [])
  assert.deepEqual(savedSnapshots, [[]])

  state.replace(initialTodos)
  assert.equal(await dispatchCommand('/clear', context), true)
  assert.deepEqual(state.snapshot(), [])
  assert.equal(historyClears, 1)
  assert.equal(savedSnapshots.length, 1)

  state.replace(initialTodos)
  assert.equal(await dispatchCommand('/new', context), true)
  assert.deepEqual(savedSnapshots.at(-1), initialTodos)
  assert.deepEqual(state.snapshot(), [])
  assert.equal(historyClears, 2)
})

test('/new preserves the current conversation when session saving fails', async () =>
{
  const output: OutputBlock[] = []
  let historyClears = 0
  let sessionClears = 0
  const context = makeCommandContext(
    {
      clearHistory: () =>
      {
        historyClears += 1
        return 3
      },
    },
    output
  )
  context.saveCurrentSession = () => ({ status: 'error' })
  context.clearSession = () =>
  {
    sessionClears += 1
  }

  assert.equal(await dispatchCommand('/new', context), true)
  assert.equal(historyClears, 0)
  assert.equal(sessionClears, 0)
  assert.match(
    plain(output.map((block) => block.content)),
    /could not be saved.*not started/
  )
})

test('dispatchCommand persists after successful manual compaction', async () =>
{
  const compacted: CompactionResult = {
    type: 'summarized',
    beforeMessages: 8,
    afterMessages: 4,
    beforeTokens: 900,
    afterTokens: 300,
  }
  const output: OutputBlock[] = []
  let saves = 0
  let rebuilds = 0

  const ctx = makeCommandContext(
    {
      getMessageCount: () => 8,
      forceCompact: async () => compacted,
    },
    output
  )
  ctx.saveCurrentSession = () =>
  {
    saves += 1
    return { status: 'saved', id: 'abcd1234' }
  }
  ctx.rebuildTranscript = () =>
  {
    rebuilds += 1
  }

  assert.equal(await dispatchCommand('/compact', ctx), true)
  assert.equal(saves, 1)
  assert.equal(rebuilds, 1)
  assert.ok(
    plain(
      output
        .filter(
          (block): block is Extract<OutputBlock, { type: 'system' }> =>
            block.type === 'system'
        )
        .map((block) => block.content)
    ).includes('Undo history cleared')
  )
})

test('dispatchCommand does not save interrupted manual compaction', async () =>
{
  const dir = await tempDir('coral-tui-compact-abort-')
  const controller = new AbortController()
  const { agent } = makeFakeAgent(dir, [], {
    inferenceClient: {
      async *chatStream(_request, signal)
      {
        assert.equal(signal, controller.signal)
        controller.abort()
        yield {
          message: { role: 'assistant', content: 'partial' },
          done: false,
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
  const beforeMessages = agent.getMessages().map((message) => message.content)
  const output: OutputBlock[] = []
  let saves = 0
  const ctx = makeCommandContext(agent, output)
  ctx.signal = controller.signal
  ctx.saveCurrentSession = () =>
  {
    saves += 1
    return { status: 'saved', id: 'abcd1234' }
  }

  assert.equal(await dispatchCommand('/compact', ctx), true)
  assert.equal(saves, 0)
  assert.equal(agent.getCompactionCount(), 0)
  assert.deepEqual(
    agent.getMessages().map((message) => message.content),
    beforeMessages
  )
  const rendered = plain(
    output
      .filter(
        (block): block is Extract<OutputBlock, { type: 'system' }> =>
          block.type === 'system'
      )
      .map((block) => block.content)
  )
  assert.ok(rendered.includes('Compaction interrupted'))
  assert.ok(!rendered.includes('Context compacted'))
})

test('dispatchCommand handles undo and redo transcript rebuilds', async () =>
{
  const output: OutputBlock[] = []
  let rebuilds = 0
  let gaugeResets = 0
  let saves = 0
  const ctx = makeCommandContext(
    {
      undoLastTurn: async () => ({
        ok: true,
        message: 'Undid last turn',
        removedMessages: 3,
        changedFiles: 1,
      }),
      redoLastTurn: async () => ({
        ok: true,
        message: 'Redid last turn',
        restoredMessages: 3,
        changedFiles: 1,
      }),
    } as Partial<Agent>,
    output
  )
  ctx.rebuildTranscript = () =>
  {
    rebuilds += 1
  }
  ctx.resetTokenUsage = () =>
  {
    gaugeResets += 1
  }
  ctx.saveCurrentSession = () =>
  {
    saves += 1
    return { status: 'saved', id: 'abcd1234' }
  }

  assert.equal(await dispatchCommand('/undo', ctx), true)
  assert.equal(await dispatchCommand('/redo', ctx), true)

  assert.equal(rebuilds, 2)
  assert.equal(gaugeResets, 2)
  assert.equal(saves, 2)
  const rendered = plain(
    output
      .filter(
        (block): block is Extract<OutputBlock, { type: 'system' }> =>
          block.type === 'system'
      )
      .map((block) => block.content)
  )
  assert.ok(
    rendered.includes('Undid last turn (3 messages removed, 1 file updated)')
  )
  assert.ok(
    rendered.includes('Redid last turn (3 messages restored, 1 file updated)')
  )
})

test('an undo committed during cancellation still reconciles and persists', async () =>
{
  let releaseUndo = () =>
  {}
  const undoGate = new Promise<void>((resolve) =>
  {
    releaseUndo = resolve
  })
  const controller = new AbortController()
  const output: OutputBlock[] = []
  let rebuilds = 0
  let saves = 0
  const context = makeCommandContext(
    {
      async undoLastTurn()
      {
        await undoGate
        return { ok: true, message: 'Undid last turn', changedFiles: 1 }
      },
    },
    output
  )
  context.signal = controller.signal
  context.pushOutput = (...blocks) =>
  {
    if (!controller.signal.aborted) output.push(...blocks)
  }
  context.rebuildTranscript = () =>
  {
    rebuilds += 1
  }
  context.saveCurrentSession = () =>
  {
    saves += 1
    return { status: 'saved', id: 'abcd1234' }
  }

  const undo = dispatchCommand('/undo', context)
  await Promise.resolve()
  controller.abort()
  releaseUndo()
  assert.equal(await undo, true)
  assert.equal(rebuilds, 1)
  assert.equal(saves, 1)
  assert.match(plain(output.map((block) => block.content)), /Undid last turn/)
})

test('dispatchCommand reports empty undo stack without saving', async () =>
{
  const output: OutputBlock[] = []
  let saves = 0
  const ctx = makeCommandContext(
    {
      undoLastTurn: async () => ({ ok: false, message: 'Nothing to undo' }),
    } as Partial<Agent>,
    output
  )
  ctx.saveCurrentSession = () =>
  {
    saves += 1
    return { status: 'saved', id: 'abcd1234' }
  }

  assert.equal(await dispatchCommand('/undo', ctx), true)
  assert.equal(saves, 0)
  assert.ok(
    plain(output.map((block) => block.content)).includes('Nothing to undo')
  )
})

test('dispatchCommand passes the command abort signal into /index', async () =>
{
  const output: OutputBlock[] = []
  const controller = new AbortController()
  let seenSignal: AbortSignal | undefined
  let closed = false
  const embeddingSpace = createEmbeddingSpace('http://ollama.test', {
    model: 'test-embed:latest',
    digest: 'a'.repeat(64),
  })
  const store: IndexStore = {
    space: embeddingSpace,
    ensureProject: () => 1,
    listFiles: () => new Map(),
    touchFile()
    {},
    upsertFile()
    {},
    deleteFile()
    {},
    deleteMissingFiles()
    {},
    search: () => [],
    close()
    {
      closed = true
    },
  }
  const ctx = makeCommandContext({} as Agent, output)
  ctx.signal = controller.signal
  ctx.buildIndexer = (cwd, host, signal) =>
  {
    assert.equal(cwd, '/tmp/project')
    assert.equal(host, 'http://localhost:11434')
    seenSignal = signal
    return {
      store,
      embeddingModel: 'test-embed',
      embeddingSpace,
      indexer: {
        ensureIndexed: async () => ({
          totalFiles: 1,
          embeddedFiles: 1,
          chunks: 1,
        }),
      } as never,
    }
  }

  assert.equal(await dispatchCommand('/index', ctx), true)
  assert.equal(seenSignal, controller.signal)
  assert.equal(closed, true)
  assert.ok(plain(output.map((block) => block.content)).includes('Indexed 1/1'))
})

test('/model honors command cancellation and reports only committed switches', async () =>
{
  const originalFetch = globalThis.fetch
  const seenSignals: Array<AbortSignal | null | undefined> = []
  globalThis.fetch = async (_input, init) =>
  {
    seenSignals.push(init?.signal)
    return new Response(
      JSON.stringify({
        models: [
          {
            name: 'next-model',
            model: 'next-model',
            size: 0,
            modified_at: '',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  try
  {
    const dir = await tempDir('coral-tui-model-command-')
    const { agent } = makeFakeAgent(dir, [])

    const abortedOutput: OutputBlock[] = []
    const aborted = new AbortController()
    aborted.abort()
    let abortedSwitches = 0
    const abortedContext = makeCommandContext(agent, abortedOutput)
    abortedContext.signal = aborted.signal
    abortedContext.switchModel = async () =>
    {
      abortedSwitches++
      return { status: 'changed' }
    }

    assert.equal(
      await dispatchCommand('/model next-model', abortedContext),
      true
    )
    assert.equal(seenSignals.at(-1), aborted.signal)
    assert.equal(abortedSwitches, 0)
    assert.ok(
      !plain(abortedOutput.map((block) => block.content)).includes(
        'Switched model'
      )
    )
    assert.match(
      plain(abortedOutput.map((block) => block.content)),
      /Model switch interrupted/
    )

    const committedOutput: OutputBlock[] = []
    let saves = 0
    const committedContext = makeCommandContext(agent, committedOutput)
    committedContext.activeModel = 'old-model'
    committedContext.switchModel = async () => ({ status: 'changed' })
    committedContext.saveCurrentSession = () =>
    {
      saves++
      return { status: 'saved', id: 'abcd1234' }
    }

    assert.equal(
      await dispatchCommand('/model next-model', committedContext),
      true
    )
    assert.equal(saves, 0)
    assert.ok(
      plain(committedOutput.map((block) => block.content)).includes(
        'Switched model: old-model'
      )
    )
  }
  finally
  {
    globalThis.fetch = originalFetch
  }
})

test('/index preserves a configured model across async missing-model failure', async () =>
{
  const output: OutputBlock[] = []
  const ctx = makeCommandContext({} as Agent, output)
  ctx.buildIndexer = async () =>
  {
    throw new RetrievalBuildError(
      'custom-embed',
      new OllamaModelIdentityError(
        'missing',
        'Embedding model "custom-embed" is not listed by Ollama'
      )
    )
  }

  assert.equal(await dispatchCommand('/index', ctx), true)
  const rendered = plain(output.map((block) => block.content))
  assert.match(rendered, /embedding model custom-embed/)
  assert.match(rendered, /ollama pull custom-embed/)
  assert.doesNotMatch(rendered, /ollama pull nomic-embed-text/)
})

test('/index does not suggest pulling for artifact identity drift', async () =>
{
  const output: OutputBlock[] = []
  const ctx = makeCommandContext({} as Agent, output)
  ctx.buildIndexer = async () =>
  {
    throw new Error(
      'Embedding model custom-embed changed artifact identity during retrieval'
    )
  }

  assert.equal(await dispatchCommand('/index', ctx), true)
  const rendered = plain(output.map((block) => block.content))
  assert.match(rendered, /changed artifact identity/)
  assert.doesNotMatch(rendered, /ollama pull/)
})
