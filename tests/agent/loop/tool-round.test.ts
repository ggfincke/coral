// tests/agent/loop/tool-round.test.ts
// causal tests for tool-round settlement, effects, and abort cardinality

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { CodeIntelService } from '../../../src/lsp/contracts.js'
import { ToolCatalog } from '../../../src/tools/catalog.js'
import type { SubagentRunner } from '../../../src/tools/subagent.js'
import type {
  Tool,
  ToolCallPresentation,
  ToolExecutionContext,
} from '../../../src/tools/tool.js'
import { AgentTodoState } from '../../../src/agent/state/todos.js'
import { DoomLoopDetector } from '../../../src/agent/loop/doom-loop.js'
import {
  ToolRoundExecutor,
  type PreparedToolRound,
  type ToolResultRoundAllowance,
} from '../../../src/agent/loop/tool-round.js'
import { estimateModelRequestMessageTokens } from '../../../src/agent/request/projection.js'
import type { ToolPermissions } from '../../../src/config/permissions.js'
import { makeTempDirPool } from '../../helpers/temp.js'

const { tempDir } = makeTempDirPool()

const codeIntel: CodeIntelService = {
  async query()
  {
    return 'unused'
  },
  async dispose()
  {},
}

const subagentRunner: SubagentRunner = async () => ({ text: 'unused' })

function createExecutor(
  cwd: string,
  permissions: ToolPermissions,
  todoState = new AgentTodoState()
): ToolRoundExecutor
{
  return new ToolRoundExecutor({
    cwd,
    ollamaHost: 'http://ollama.test',
    permissions,
    subagentRunner,
    codeIntel,
    todoState,
  })
}

function allowanceFor(
  round: PreparedToolRound,
  extraTokens = 100_000
): ToolResultRoundAllowance
{
  const minimumTokens = round.minimumResultMessages.map(
    estimateModelRequestMessageTokens
  )
  return {
    minimumTokens,
    remainingTokens:
      minimumTokens.reduce((total, tokens) => total + tokens, 0) + extraTokens,
  }
}

test('ToolRoundExecutor isolates prepared calls and rejects an undersized allowance', async () =>
{
  const cwd = await tempDir('coral-tool-round-reservation-')
  let executions = 0
  let callbacks = 0
  const tool: Tool = {
    name: 'search_code',
    description: 'reservation fixture',
    parameters: { type: 'object', properties: {} },
    parallelSafe: true,
    async execute()
    {
      executions++
      return { output: 'unexpected' }
    },
  }
  const catalog = new ToolCatalog({ trustedTools: [tool] })
  const executor = createExecutor(cwd, { search_code: 'always_allow' })
  const source = [
    {
      type: 'function' as const,
      function: {
        name: 'Search-Code',
        arguments: {
          nested: { value: 'original' },
          values: ['original'],
        },
      },
    },
  ]
  const round = executor.prepare(source, catalog)

  assert.equal(source[0]!.function.name, 'Search-Code')
  assert.equal(round.calls[0]!.function.name, 'search_code')
  assert.notEqual(round.calls[0], source[0])
  assert.notEqual(round.storedCalls[0], round.calls[0])
  assert.equal(Object.isFrozen(round.calls), true)
  assert.equal(Object.isFrozen(round.calls[0]), true)
  assert.equal(Object.isFrozen(round.calls[0]!.function), true)
  assert.equal(Object.isFrozen(round.calls[0]!.function.arguments), true)
  assert.equal(Object.isFrozen(round.calls[0]!.function.arguments.nested), true)
  assert.equal(Object.isFrozen(round.storedCalls), true)
  assert.equal(Object.isFrozen(round.storedCalls[0]), true)
  assert.equal(Object.isFrozen(round.minimumResultMessages), true)
  assert.equal(Object.isFrozen(round.minimumResultMessages[0]), true)

  source[0]!.function.name = 'mutated'
  const sourceNested = source[0]!.function.arguments.nested as { value: string }
  const sourceValues = source[0]!.function.arguments.values as string[]
  sourceNested.value = 'mutated'
  sourceValues.push('mutated')
  assert.equal(round.calls[0]!.function.name, 'search_code')
  assert.deepEqual(round.calls[0]!.function.arguments, {
    nested: { value: 'original' },
    values: ['original'],
  })

  const mismatched = await executor.execute({
    round,
    allowance: {
      minimumTokens: [0],
      remainingTokens: 0,
    },
    doomLoop: new DoomLoopDetector(),
    events: {
      onToolCall()
      {
        callbacks++
      },
      onToolApproval()
      {
        callbacks++
        return Promise.resolve(true)
      },
      onToolResult()
      {
        callbacks++
      },
    },
  })

  assert.equal(mismatched.status, 'failed')
  if (mismatched.status !== 'failed') return
  assert.match(mismatched.error.message, /does not match the prepared minimum/i)
  assert.equal(Object.isFrozen(mismatched.outcome), true)

  const underfundedRound = executor.prepare(round.calls, catalog)
  const allowance = allowanceFor(underfundedRound, 0)
  const execution = await executor.execute({
    round: underfundedRound,
    allowance: {
      minimumTokens: allowance.minimumTokens,
      remainingTokens: allowance.remainingTokens - 1,
    },
    doomLoop: new DoomLoopDetector(),
    events: {
      onToolCall()
      {
        callbacks++
      },
      onToolApproval()
      {
        callbacks++
        return Promise.resolve(true)
      },
      onToolResult()
      {
        callbacks++
      },
    },
  })

  assert.equal(execution.status, 'failed')
  if (execution.status !== 'failed') return
  assert.match(execution.error.message, /cannot fit every reserved minimum/i)
  assert.equal(executions, 0)
  assert.equal(callbacks, 0)
  assert.deepEqual(execution.outcome.toolResults, [])
})

test('ToolRoundExecutor preserves catalog, batching, effects, and callback-failure progress', async () =>
{
  const cwd = await tempDir('coral-tool-round-')
  const todoState = new AgentTodoState([
    { content: 'before', status: 'pending' },
  ])
  let active = 0
  let maxActive = 0
  let searchExecutions = 0
  let seenContext: ToolExecutionContext | undefined

  const searchTool: Tool = {
    name: 'search_code',
    description: 'parallel effect fixture',
    parameters: { type: 'object', properties: {} },
    parallelSafe: true,
    display: { label: 'Search' },
    async execute(_args, context)
    {
      const execution = ++searchExecutions
      seenContext = context
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active--

      if (execution === 1)
      {
        return {
          output: 'first result',
          diff: 'first diff',
          change: { path: 'first.ts', before: 'old', after: 'new' },
        }
      }
      return {
        output: 'second result',
        todoChange: {
          before: [{ content: 'before', status: 'pending' }],
          after: [{ content: 'after', status: 'completed' }],
        },
      }
    },
  }
  const bashTool: Tool = {
    name: 'bash',
    description: 'approval effect fixture',
    parameters: { type: 'object', properties: {} },
    display: { label: 'Bash' },
    async execute()
    {
      return {
        output: 'approved result',
        diff: 'approved diff',
        change: { path: 'second.ts', before: 'before', after: 'after' },
        repaired: true,
      }
    },
  }
  const catalog = new ToolCatalog({
    trustedTools: [searchTool, bashTool],
  })
  const executor = createExecutor(
    cwd,
    {
      search_code: 'always_allow',
      bash: 'require_approval',
    },
    todoState
  )
  const round = executor.prepare(
    [
      {
        type: 'function',
        function: {
          index: 0,
          name: 'Search-Code',
          arguments: { query: 'same' },
        },
      },
      {
        type: 'function',
        function: {
          index: 1,
          name: 'search_code',
          arguments: { query: 'same' },
        },
      },
      {
        type: 'function',
        function: { index: 2, name: 'bash', arguments: {} },
      },
    ],
    catalog
  )

  assert.equal(round.nameRepairs, 1)
  assert.deepEqual(
    round.storedCalls.map((call) => call.function.name),
    ['search_code', 'search_code', 'bash']
  )

  const calls: Array<{
    name: string
    id: number
    presentation?: ToolCallPresentation
  }> = []
  const results: string[] = []
  let approvalPresentation: ToolCallPresentation | undefined
  const execution = await executor.execute({
    round,
    allowance: allowanceFor(round),
    doomLoop: new DoomLoopDetector({ threshold: 2, window: 12 }),
    events: {
      onToolCall(name, _args, id, presentation)
      {
        calls.push({ name, id, presentation })
      },
      onToolApproval(_name, _args, presentation)
      {
        approvalPresentation = presentation
        return Promise.resolve(true)
      },
      onToolResult(name)
      {
        results.push(name)
        if (name === 'bash') throw new Error('tool-result view failed')
      },
    },
  })

  assert.equal(execution.status, 'failed')
  if (execution.status !== 'failed') return
  assert.match(execution.error.message, /tool-result view failed/)
  assert.equal(maxActive, 2)
  assert.deepEqual(
    calls.map(({ name, id }) => ({ name, id })),
    [
      { name: 'search_code', id: 0 },
      { name: 'search_code', id: 1 },
      { name: 'bash', id: 2 },
    ]
  )
  assert.deepEqual(results, ['search_code', 'search_code', 'bash'])
  assert.equal(calls[2]?.presentation, approvalPresentation)
  assert.equal(execution.outcome.toolResults.length, 3)
  assert.deepEqual(execution.outcome.effects.editDiffs, [
    'first diff',
    'approved diff',
  ])
  assert.deepEqual(
    execution.outcome.effects.fileChanges.map((change) => change.path),
    ['first.ts', 'second.ts']
  )
  assert.deepEqual(execution.outcome.effects.todoChange, {
    before: [{ content: 'before', status: 'pending' }],
    after: [{ content: 'after', status: 'completed' }],
  })
  assert.deepEqual(execution.outcome.reliability, {
    validationFailures: 0,
    editRepairs: 1,
  })
  assert.deepEqual(execution.outcome.doomTrip, {
    kind: 'repeat-call',
    detail: 'search_code',
    count: 2,
  })
  assert.equal(Object.isFrozen(execution.outcome), true)
  assert.equal(Object.isFrozen(execution.outcome.toolResults), true)
  assert.equal(Object.isFrozen(execution.outcome.toolResults[0]), true)
  assert.equal(Object.isFrozen(execution.outcome.effects), true)
  assert.equal(Object.isFrozen(execution.outcome.effects.editDiffs), true)
  assert.equal(Object.isFrozen(execution.outcome.effects.fileChanges), true)
  assert.equal(Object.isFrozen(execution.outcome.effects.fileChanges[0]), true)
  assert.equal(Object.isFrozen(execution.outcome.effects.todoChange), true)
  assert.equal(
    Object.isFrozen(execution.outcome.effects.todoChange?.after),
    true
  )
  assert.equal(Object.isFrozen(execution.outcome.reliability), true)
  assert.equal(Object.isFrozen(execution.outcome.doomTrip), true)
  assert.equal(execution.outcome.aborted, false)
  assert.equal(seenContext?.cwd, cwd)
  assert.equal(seenContext?.ollamaHost, 'http://ollama.test')
  assert.equal(seenContext?.allowOutsideWorkspace, false)
  assert.equal(seenContext?.todoState, todoState)
})

test('ToolRoundExecutor stages every parallel mutation before result callbacks', async () =>
{
  const cwd = await tempDir('coral-tool-round-parallel-callback-')
  const firstChange = { path: 'first.ts', before: 'old', after: 'new' }
  const secondChange = { path: 'second.ts', before: null, after: 'created' }
  const secondTodo = {
    before: [{ content: 'before', status: 'pending' as const }],
    after: [{ content: 'after', status: 'completed' as const }],
  }
  let executions = 0
  const tool: Tool = {
    name: 'search_code',
    description: 'parallel callback fixture',
    parameters: { type: 'object', properties: {} },
    parallelSafe: true,
    async execute()
    {
      executions++
      if (executions === 1)
      {
        return { output: 'first', diff: 'first diff', change: firstChange }
      }
      return {
        output: 'second',
        diff: 'second diff',
        change: secondChange,
        todoChange: secondTodo,
        repaired: true,
      }
    },
  }
  const catalog = new ToolCatalog({ trustedTools: [tool] })
  const executor = createExecutor(cwd, { search_code: 'always_allow' })
  const round = executor.prepare(
    [
      { function: { name: 'search_code', arguments: { query: 'same' } } },
      { function: { name: 'search_code', arguments: { query: 'same' } } },
    ],
    catalog
  )
  const callIds: number[] = []
  const resultIds: number[] = []

  const execution = await executor.execute({
    round,
    allowance: allowanceFor(round),
    doomLoop: new DoomLoopDetector({ threshold: 2, window: 12 }),
    events: {
      onToolCall(_name, _args, id)
      {
        callIds.push(id)
      },
      onToolApproval()
      {
        return Promise.resolve(true)
      },
      onToolResult(_name, _result, _error, id)
      {
        resultIds.push(id)
        if (id === 0) throw new Error('first parallel callback failed')
      },
    },
  })

  assert.equal(execution.status, 'failed')
  if (execution.status !== 'failed') return
  assert.match(execution.error.message, /first parallel callback failed/)
  assert.equal(executions, 2)
  assert.deepEqual(callIds, [0, 1])
  assert.deepEqual(resultIds, [0])
  assert.equal(execution.outcome.toolResults.length, 2)
  assert.deepEqual(execution.outcome.effects.editDiffs, [
    'first diff',
    'second diff',
  ])
  assert.deepEqual(
    execution.outcome.effects.fileChanges.map((change) => change.path),
    ['first.ts', 'second.ts']
  )
  assert.deepEqual(execution.outcome.effects.todoChange, secondTodo)
  assert.deepEqual(execution.outcome.reliability, {
    validationFailures: 0,
    editRepairs: 1,
  })
  assert.deepEqual(execution.outcome.doomTrip, {
    kind: 'repeat-call',
    detail: 'search_code',
    count: 2,
  })

  secondChange.path = 'mutated.ts'
  secondTodo.after[0]!.content = 'mutated'
  assert.equal(execution.outcome.effects.fileChanges[1]!.path, 'second.ts')
  assert.equal(execution.outcome.effects.todoChange?.after[0]?.content, 'after')
})

test('ToolRoundExecutor isolates validator failures and records a final-call abort', async () =>
{
  const cwd = await tempDir('coral-tool-round-validator-')
  const controller = new AbortController()
  let executions = 0
  const tool: Tool = {
    name: 'search_code',
    description: 'validator isolation fixture',
    parameters: { type: 'object', properties: {} },
    parallelSafe: true,
    validateArgs(args)
    {
      if (args.fail === true) throw new Error('validator exploded')
      return { ok: true, args }
    },
    async execute()
    {
      executions++
      controller.abort()
      return {
        output: 'successful sibling',
        diff: 'successful diff',
        change: { path: 'success.ts', before: 'old', after: 'new' },
      }
    },
  }
  const catalog = new ToolCatalog({ trustedTools: [tool] })
  const executor = createExecutor(cwd, { search_code: 'always_allow' })
  const round = executor.prepare(
    [
      { function: { name: 'search_code', arguments: { fail: true } } },
      { function: { name: 'search_code', arguments: { fail: false } } },
    ],
    catalog
  )
  const resultIds: number[] = []

  const execution = await executor.execute({
    round,
    allowance: allowanceFor(round),
    doomLoop: new DoomLoopDetector(),
    signal: controller.signal,
    events: {
      onToolCall()
      {},
      onToolApproval()
      {
        return Promise.resolve(true)
      },
      onToolResult(_name, _result, _error, id)
      {
        resultIds.push(id)
      },
    },
  })

  assert.equal(execution.status, 'settled')
  assert.equal(executions, 1)
  assert.equal(execution.outcome.aborted, true)
  assert.deepEqual(resultIds, [0, 1])
  assert.equal(execution.outcome.toolResults.length, 2)
  assert.match(execution.outcome.toolResults[0]!.content, /validator exploded/)
  assert.equal(execution.outcome.toolResults[1]!.content, 'successful sibling')
  assert.deepEqual(execution.outcome.effects.editDiffs, ['successful diff'])
  assert.deepEqual(execution.outcome.effects.fileChanges, [
    { path: 'success.ts', before: 'old', after: 'new' },
  ])
})

test('ToolRoundExecutor fills every model reply after approval abort', async () =>
{
  const cwd = await tempDir('coral-tool-round-abort-')
  let bashExecutions = 0
  const readTool: Tool = {
    name: 'read_file',
    description: 'read fixture',
    parameters: { type: 'object', properties: {} },
    parallelSafe: true,
    async execute()
    {
      return { output: 'read result' }
    },
  }
  const bashTool: Tool = {
    name: 'bash',
    description: 'approval fixture',
    parameters: { type: 'object', properties: {} },
    async execute()
    {
      bashExecutions++
      return { output: 'unexpected' }
    },
  }
  const catalog = new ToolCatalog({
    trustedTools: [readTool, bashTool],
  })
  const executor = createExecutor(cwd, {
    read_file: 'always_allow',
    bash: 'require_approval',
  })
  const round = executor.prepare(
    [
      {
        type: 'function',
        function: { name: 'read_file', arguments: {} },
      },
      {
        type: 'function',
        function: { name: 'bash', arguments: {} },
      },
      {
        type: 'function',
        function: { name: 'read_file', arguments: {} },
      },
    ],
    catalog
  )
  const controller = new AbortController()
  const calls: string[] = []
  const results: string[] = []

  const execution = await executor.execute({
    round,
    allowance: allowanceFor(round),
    doomLoop: new DoomLoopDetector(),
    signal: controller.signal,
    events: {
      onToolCall(name)
      {
        calls.push(name)
      },
      onToolApproval()
      {
        controller.abort()
        return new Promise<boolean>(() =>
        {})
      },
      onToolResult(name)
      {
        results.push(name)
      },
    },
  })

  assert.equal(execution.status, 'settled')
  assert.equal(execution.outcome.aborted, true)
  assert.equal(execution.outcome.toolResults.length, 3)
  assert.deepEqual(
    execution.outcome.toolResults.map((message) => message.tool_name),
    ['read_file', 'bash', 'read_file']
  )
  assert.match(execution.outcome.toolResults[1]?.content ?? '', /interrupted/i)
  assert.match(execution.outcome.toolResults[2]?.content ?? '', /interrupted/i)
  assert.deepEqual(calls, ['read_file', 'bash'])
  assert.deepEqual(results, ['read_file', 'bash'])
  assert.equal(bashExecutions, 0)
})
