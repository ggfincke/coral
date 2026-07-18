// tests/agent/conversation-state.test.ts
// contract tests for pure conversation-state transitions

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  ConversationState,
  type PreparedConversationReplay,
} from '../../src/agent/conversation-state.js'
import {
  estimateTotalTokens,
  FROZEN_SUMMARY_MARKER,
  type CompactionConfig,
} from '../../src/agent/compaction.js'
import type { AttachmentReport } from '../../src/types/attachments.js'
import type { OllamaMessage } from '../../src/types/inference.js'
import type {
  UndoFileChange,
  UndoTodoChange,
  UndoTurn,
} from '../../src/types/undo.js'

const compactConfig: CompactionConfig = {
  contextWindow: 4_000,
  minRecentMessages: 2,
  minMessagesForCompaction: 4,
}

function assertExactEstimate(state: ConversationState): void
{
  assert.equal(
    state.getEstimatedTokens(),
    estimateTotalTokens(state.getMessages())
  )
}

function requireReadyReplay(
  replay: PreparedConversationReplay
): Extract<PreparedConversationReplay, { status: 'ready' }>
{
  assert.equal(replay.status, 'ready')
  return replay as Extract<PreparedConversationReplay, { status: 'ready' }>
}

test('ConversationState keeps exact cloned message, anchor, report, & effect state', () =>
{
  const system: OllamaMessage = { role: 'system', content: 'original system' }
  const state = new ConversationState(system)
  system.content = 'mutated outside'
  assert.equal(state.getMessages()[0]!.content, 'original system')
  assertExactEstimate(state)

  const assistant: OllamaMessage = {
    role: 'assistant',
    content: 'planning',
    tool_calls: [
      {
        function: {
          name: 'read_file',
          arguments: { path: { nested: true } },
        },
      },
    ],
  }
  state.appendMessage(assistant)
  ;(
    assistant.tool_calls![0]!.function.arguments.path as { nested: boolean }
  ).nested = false
  assert.deepEqual(
    state.getMessages()[1]!.tool_calls![0]!.function.arguments.path,
    { nested: true }
  )
  assertExactEstimate(state)

  const anchor = state.acceptUserMessage('inspect files', 'inspect @large.txt')
  const report: AttachmentReport = {
    attached: [{ path: 'large.txt', truncated: true }],
    skipped: [{ path: 'binary.dat', reason: 'binary' }],
    omittedOverBudget: 2,
  }
  const expanded =
    'inspect files\n\nReferenced files (from @-mentions):\nlarge bytes'
  assert.equal(state.commitActiveUserMessage(anchor, expanded, report), true)
  ;(report.attached[0] as { path: string }).path = 'mutated.txt'
  assert.equal(state.getMessage(anchor)?.content, expanded)
  assert.deepEqual(state.getMessage(anchor)?.attachmentReport, {
    attached: [{ path: 'large.txt', truncated: true }],
    skipped: [{ path: 'binary.dat', reason: 'binary' }],
    omittedOverBudget: 2,
  })

  state.appendMessage({ role: 'assistant', content: 'reviewed the files' })
  const changes: UndoFileChange[] = [
    { path: 'src/a.ts', before: 'old', after: 'new' },
  ]
  const todoChange: UndoTodoChange = {
    before: [{ content: 'inspect', status: 'pending' }],
    after: [{ content: 'inspect', status: 'completed' }],
  }
  assert.deepEqual(state.finalizeActiveTurn(anchor, changes, todoChange), {
    recorded: true,
    warningAdded: false,
  })
  changes[0]!.after = 'mutated'
  todoChange.after[0]!.content = 'mutated'

  const firstUndo = state.getUndoStack()[0]!
  assert.equal(firstUndo.userMessage, expanded)
  assert.equal(firstUndo.messages[0]!.content, expanded)
  assert.equal(firstUndo.changes[0]!.after, 'new')
  assert.equal(firstUndo.todoChange!.after[0]!.content, 'inspect')
  assert.deepEqual(firstUndo.messages[0]!.attachmentReport, {
    attached: [{ path: 'large.txt', truncated: true }],
    skipped: [{ path: 'binary.dat', reason: 'binary' }],
    omittedOverBudget: 2,
  })

  const zeroEffectAnchor = state.acceptUserMessage('no effects')
  state.appendMessage({ role: 'assistant', content: 'done' })
  assert.deepEqual(state.finalizeActiveTurn(zeroEffectAnchor), {
    recorded: true,
    warningAdded: false,
  })
  const zeroEffectTurn = state.getUndoStack().at(-1)!
  assert.equal(zeroEffectTurn.userMessage, 'no effects')
  assert.deepEqual(zeroEffectTurn.changes, [])

  const leakedSnapshot = state.getMessages()
  leakedSnapshot[1]!.content = 'mutated snapshot'
  ;(
    leakedSnapshot[1]!.tool_calls![0]!.function.arguments.path as {
      nested: boolean
    }
  ).nested = false
  ;(leakedSnapshot[2]!.attachmentReport!.attached[0] as { path: string }).path =
    'mutated snapshot path'
  assert.equal(state.getMessages()[1]!.content, 'planning')
  assert.deepEqual(
    state.getMessages()[1]!.tool_calls![0]!.function.arguments.path,
    { nested: true }
  )
  assert.equal(
    state.getMessages()[2]!.attachmentReport!.attached[0]!.path,
    'large.txt'
  )
  assertExactEstimate(state)

  const lostFileState = new ConversationState('system')
  const lostFileAnchor = lostFileState.acceptUserMessage('edit')
  lostFileState.clearHistory()
  assert.deepEqual(
    lostFileState.finalizeActiveTurn(lostFileAnchor, [
      { path: 'src/a.ts', before: null, after: 'created' },
    ]),
    { recorded: false, warningAdded: true }
  )
  assert.equal(lostFileState.getUndoStack().length, 0)
  assert.match(
    lostFileState.getMessages().at(-1)!.content,
    /undo could not record this turn's file changes/
  )
  assertExactEstimate(lostFileState)

  const lostTodoState = new ConversationState('system')
  const lostTodoAnchor = lostTodoState.acceptUserMessage('todo')
  lostTodoState.clearHistory()
  assert.deepEqual(
    lostTodoState.finalizeActiveTurn(lostTodoAnchor, [], {
      before: [],
      after: [{ content: 'todo', status: 'completed' }],
    }),
    { recorded: false, warningAdded: false }
  )
  assert.deepEqual(lostTodoState.getMessages(), [
    { role: 'system', content: 'system' },
  ])
})

test('ConversationState preserves compaction asymmetries & the complete active trim tail', () =>
{
  const state = new ConversationState('current system')
  const firstAnchor = state.acceptUserMessage('first turn')
  state.appendMessages([
    {
      role: 'assistant',
      content: 'using tools',
      tool_calls: [
        {
          function: { name: 'read_file', arguments: { path: 'one.txt' } },
        },
      ],
    },
    { role: 'tool', tool_name: 'read_file', content: 'x'.repeat(2_000) },
    { role: 'tool', tool_name: 'read_file', content: 'y'.repeat(2_000) },
    { role: 'assistant', content: 'done' },
  ])
  state.finalizeActiveTurn(firstAnchor, [
    { path: 'one.txt', before: 'old', after: 'new' },
  ])
  for (let index = 0; index < 5; index++)
  {
    state.appendMessages([
      { role: 'user', content: `question ${index}` },
      { role: 'assistant', content: `answer ${index}` },
    ])
  }

  const failedPlan = state.prepareSummary({
    mode: 'automatic',
    config: compactConfig,
  })!
  assert.deepEqual(state.recordAutomaticSummaryFailure(failedPlan.plan), {
    status: 'recorded',
    failureCount: 1,
  })
  const undoBeforePrune = state.getUndoStack()
  const pruned = state.pruneToolResults('2026-07-18T01:00:00.000Z', 0)
  assert.equal(pruned?.type, 'pruned')
  assert.equal(pruned?.prunedResults, 2)
  assert.deepEqual(state.getUndoStack(), undoBeforePrune)
  assert.deepEqual(state.getCompactionMetrics(), {
    failureCount: 1,
    successfulCount: 1,
    lastCompactedAt: '2026-07-18T01:00:00.000Z',
  })
  assertExactEstimate(state)

  const saved: OllamaMessage[] = [
    { role: 'system', content: 'saved system one' },
    { role: 'system', content: 'saved system two' },
    {
      role: 'user',
      content: `${FROZEN_SUMMARY_MARKER} ...]\n\nrestored summary`,
    },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'a3' },
  ]
  state.restoreMessages(saved)
  saved[2]!.content = 'mutated restored input'
  assert.equal(state.getMessages()[0]!.content, 'current system')
  assert.equal(
    state.getMessages().filter((message) => message.role === 'system').length,
    1
  )
  assert.equal(state.getFrozenPrefixLength(), 2)
  assert.match(state.getMessages()[1]!.content, /restored summary/)
  assert.equal(state.getUndoStack().length, 0)
  assert.deepEqual(state.getCompactionMetrics(), {
    failureCount: 1,
    successfulCount: 1,
    lastCompactedAt: '2026-07-18T01:00:00.000Z',
  })

  const restoredMessages = state.getMessages()
  const q3Index = restoredMessages.findIndex(
    (message) => message.content === 'q3'
  )
  state.restoreUndoStack([
    {
      startIndex: q3Index,
      endIndex: restoredMessages.length,
      userMessage: 'q3',
      messages: restoredMessages.slice(q3Index),
      changes: [],
    },
  ])
  const manual = state.prepareSummary({
    mode: 'manual',
    config: compactConfig,
  })!
  const manualCommit = state.commitSummary(
    manual.plan,
    'manual summary',
    '2026-07-18T02:00:00.000Z'
  )
  assert.equal(manualCommit.status, 'committed')
  assert.equal(state.getUndoStack().length, 0)
  assert.deepEqual(state.getCompactionMetrics(), {
    failureCount: 1,
    successfulCount: 2,
    lastCompactedAt: '2026-07-18T02:00:00.000Z',
  })

  for (let index = 0; index < 4; index++)
  {
    state.appendMessages([
      { role: 'user', content: `automatic ${index}` },
      { role: 'assistant', content: `automatic answer ${index}` },
    ])
  }
  const automatic = state.prepareSummary({
    mode: 'automatic',
    config: compactConfig,
  })!
  assert.equal(
    state.commitSummary(
      automatic.plan,
      'automatic summary',
      '2026-07-18T03:00:00.000Z'
    ).status,
    'committed'
  )
  assert.equal(state.getCompactionMetrics().failureCount, 0)

  for (let index = 0; index < 3; index++)
  {
    state.appendMessages([
      { role: 'user', content: `hard fit history ${index}` },
      { role: 'assistant', content: `hard fit answer ${index}` },
    ])
  }
  const hardFailurePlan = state.prepareSummary({
    mode: 'automatic',
    config: compactConfig,
  })!
  state.recordAutomaticSummaryFailure(hardFailurePlan.plan)
  assert.equal(state.getCompactionMetrics().failureCount, 1)
  const hardAnchor = state.acceptUserMessage('active hard-fit turn')
  state.appendMessage({ role: 'assistant', content: 'active partial' })
  const hardFit = state.prepareSummary({ mode: 'hard-fit' })!
  assert.equal(
    state.commitSummary(
      hardFit.plan,
      'hard-fit summary',
      '2026-07-18T04:00:00.000Z'
    ).status,
    'committed'
  )
  assert.equal(state.getCompactionMetrics().failureCount, 0)
  assert.deepEqual(state.finalizeActiveTurn(hardAnchor), {
    recorded: true,
    warningAdded: false,
  })

  const beforeClearMetrics = state.getCompactionMetrics()
  state.appendMessages([
    { role: 'user', content: 'clear history one' },
    { role: 'assistant', content: 'clear answer one' },
    { role: 'user', content: 'clear history two' },
    { role: 'assistant', content: 'clear answer two' },
  ])
  const clearFailurePlan = state.prepareSummary({
    mode: 'automatic',
    config: compactConfig,
  })!
  state.recordAutomaticSummaryFailure(clearFailurePlan.plan)
  const metricsWithFailure = state.getCompactionMetrics()
  assert.equal(metricsWithFailure.failureCount, 1)
  state.clearHistory()
  assert.deepEqual(state.getCompactionMetrics(), metricsWithFailure)
  assert.equal(state.getMessages().length, 1)
  assert.ok(beforeClearMetrics.successfulCount > 0)

  const thresholdState = new ConversationState('system')
  const priorAnchor = thresholdState.acceptUserMessage('prior turn')
  thresholdState.appendMessage({ role: 'assistant', content: 'prior answer' })
  thresholdState.finalizeActiveTurn(priorAnchor, [
    { path: 'prior.txt', before: null, after: 'created' },
  ])
  for (let index = 0; index < 4; index++)
  {
    thresholdState.appendMessages([
      { role: 'user', content: `old ${index}` },
      { role: 'assistant', content: `old answer ${index}` },
    ])
  }
  const activeAnchor = thresholdState.acceptUserMessage('active turn')
  thresholdState.appendMessage({ role: 'assistant', content: 'partial one' })
  const beforeNoDrop = thresholdState.getMessages().length
  const firstFailure = thresholdState.prepareSummary({
    mode: 'automatic',
    config: compactConfig,
  })!
  thresholdState.recordAutomaticSummaryFailure(firstFailure.plan, 999)
  const secondFailure = thresholdState.prepareSummary({
    mode: 'automatic',
    config: compactConfig,
  })!
  const threshold = thresholdState.recordAutomaticSummaryFailure(
    secondFailure.plan,
    999
  )
  assert.deepEqual(threshold, { status: 'recorded', failureCount: 0 })
  assert.equal(thresholdState.getMessages().length, beforeNoDrop)
  assert.equal(thresholdState.getUndoStack().length, 0)
  assert.deepEqual(thresholdState.getCompactionMetrics(), {
    failureCount: 0,
    successfulCount: 0,
    lastCompactedAt: null,
  })

  thresholdState.appendMessages([
    { role: 'tool', tool_name: 'read_file', content: 'active tool output' },
    { role: 'assistant', content: 'partial two' },
    { role: 'assistant', content: 'partial three' },
  ])
  const trimmed = thresholdState.trimToMax(2)
  assert.ok(trimmed.afterMessages > 2)
  assert.equal(thresholdState.indexOf(activeAnchor), 1)
  assert.deepEqual(
    thresholdState
      .getMessages()
      .slice(1)
      .map((message) => message.content),
    [
      'active turn',
      'partial one',
      'active tool output',
      'partial two',
      'partial three',
    ]
  )
  assertExactEstimate(thresholdState)

  const metricsState = new ConversationState('metrics system')
  const metricsAnchor = metricsState.acceptUserMessage('metrics turn')
  metricsState.appendMessages([
    { role: 'tool', tool_name: 'read_file', content: 'z'.repeat(2_000) },
    { role: 'assistant', content: 'metrics answer one' },
    { role: 'user', content: 'metrics question two' },
    { role: 'assistant', content: 'metrics answer two' },
    { role: 'user', content: 'metrics question three' },
    { role: 'assistant', content: 'metrics answer three' },
  ])
  metricsState.finalizeActiveTurn(metricsAnchor)
  const metricsFailure = metricsState.prepareSummary({
    mode: 'automatic',
    config: compactConfig,
  })!
  metricsState.recordAutomaticSummaryFailure(metricsFailure.plan)
  metricsState.pruneToolResults('2026-07-18T06:00:00.000Z', 0)
  const beforeMetricsReset = {
    messages: metricsState.getMessages(),
    undo: metricsState.getUndoStack(),
    redo: metricsState.getRedoStack(),
  }
  assert.deepEqual(metricsState.getCompactionMetrics(), {
    failureCount: 1,
    successfulCount: 1,
    lastCompactedAt: '2026-07-18T06:00:00.000Z',
  })
  metricsState.resetCompactionMetrics()
  assert.deepEqual(metricsState.getCompactionMetrics(), {
    failureCount: 0,
    successfulCount: 0,
    lastCompactedAt: null,
  })
  assert.deepEqual(
    {
      messages: metricsState.getMessages(),
      undo: metricsState.getUndoStack(),
      redo: metricsState.getRedoStack(),
    },
    beforeMetricsReset
  )
  assertExactEstimate(metricsState)
})

test('ConversationState replay plans reject drift, clear misalignment, & never leak mutable state', () =>
{
  const state = new ConversationState('system')
  const anchor = state.acceptUserMessage('change files')
  state.appendMessage({ role: 'assistant', content: 'changed' })
  state.finalizeActiveTurn(
    anchor,
    [{ path: 'file.txt', before: 'old', after: 'new' }],
    {
      before: [{ content: 'change', status: 'pending' }],
      after: [{ content: 'change', status: 'completed' }],
    }
  )

  const preparedUndo = requireReadyReplay(state.prepareUndo())
  preparedUndo.turn.userMessage = 'mutated plan'
  preparedUndo.turn.messages[0]!.content = 'mutated plan'
  preparedUndo.turn.changes[0]!.after = 'mutated plan'
  preparedUndo.turn.todoChange!.after[0]!.content = 'mutated plan'
  assert.deepEqual(state.commitReplay(preparedUndo.plan), {
    status: 'committed',
    kind: 'undo',
    removedMessages: 2,
  })
  assert.deepEqual(state.getMessages(), [{ role: 'system', content: 'system' }])
  assert.equal(state.getRedoStack()[0]!.userMessage, 'change files')
  assert.equal(state.getRedoStack()[0]!.changes[0]!.after, 'new')
  assert.equal(state.getRedoStack()[0]!.todoChange!.after[0]!.content, 'change')

  const failedFileReplay = requireReadyReplay(state.prepareRedo())
  const beforeFailedReplay = {
    messages: state.getMessages(),
    undo: state.getUndoStack(),
    redo: state.getRedoStack(),
  }
  assert.deepEqual(
    {
      messages: state.getMessages(),
      undo: state.getUndoStack(),
      redo: state.getRedoStack(),
    },
    beforeFailedReplay
  )
  assert.deepEqual(state.commitReplay(failedFileReplay.plan), {
    status: 'committed',
    kind: 'redo',
    restoredMessages: 2,
  })
  assert.equal(state.getMessages()[1]!.content, 'change files')
  assertExactEstimate(state)

  const staleUndo = requireReadyReplay(state.prepareUndo())
  state.replaceSystemMessage('replaced system')
  const beforeStaleCommit = state.getMessages()
  assert.deepEqual(state.commitReplay(staleUndo.plan), { status: 'stale' })
  assert.deepEqual(state.getMessages(), beforeStaleCommit)
  assert.equal(state.getUndoStack().length, 1)

  const currentUndo = requireReadyReplay(state.prepareUndo())
  state.commitReplay(currentUndo.plan)
  const currentRedo = requireReadyReplay(state.prepareRedo())
  state.commitReplay(currentRedo.plan)

  for (let index = 0; index < 3; index++)
  {
    state.appendMessages([
      { role: 'user', content: `summary ${index}` },
      { role: 'assistant', content: `summary answer ${index}` },
    ])
  }
  const summaryPlan = state.prepareSummary({
    mode: 'manual',
    config: compactConfig,
  })!
  summaryPlan.messages[0]!.content = 'mutated summary input'
  assert.notEqual(state.getMessages()[1]!.content, 'mutated summary input')
  state.appendMessage({ role: 'assistant', content: 'revision drift' })
  const beforeStaleSummary = state.getMessages()
  assert.deepEqual(
    state.commitSummary(
      summaryPlan.plan,
      'should not commit',
      '2026-07-18T05:00:00.000Z'
    ),
    { status: 'stale' }
  )
  assert.deepEqual(state.getMessages(), beforeStaleSummary)

  const misalignedUndo: UndoTurn = {
    startIndex: 1,
    endIndex: state.getMessages().length,
    userMessage: 'wrong user bytes',
    messages: state.getMessages().slice(1),
    changes: [],
  }
  const validRedo: UndoTurn = {
    startIndex: state.getMessages().length,
    endIndex: state.getMessages().length + 1,
    userMessage: 'redo',
    messages: [{ role: 'user', content: 'redo' }],
    changes: [],
  }
  state.restoreUndoStack([misalignedUndo], [validRedo])
  assert.deepEqual(state.prepareUndo(), {
    status: 'misaligned',
    kind: 'undo',
  })
  assert.equal(state.getUndoStack().length, 0)
  assert.equal(state.getRedoStack().length, 0)
  assertExactEstimate(state)
})
