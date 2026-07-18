// tests/agent/state/conversation-state.test.ts
// conversation-state ownership and compaction helper contracts

import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  buildCompactedMessages,
  buildCompactionPrompt,
  countFrozenPrefix,
  estimateTotalTokens,
  FROZEN_SUMMARY_MARKER,
  MAX_FROZEN_SUMMARIES,
  pruneToolResults,
  splitForCompaction,
  stripThinkingForCompaction,
  type CompactionConfig,
} from '../../../src/agent/state/compaction.js'
import {
  ConversationState,
  type PreparedConversationReplay,
} from '../../../src/agent/state/conversation.js'
import type { AttachmentReport } from '../../../src/types/attachments.js'
import type { OllamaMessage } from '../../../src/types/inference.js'
import type {
  UndoFileChange,
  UndoTodoChange,
  UndoTurn,
} from '../../../src/types/undo.js'

describe('ConversationState', () =>
{
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
})

describe('compaction helpers', () =>
{
  function buildConversation(turns: number): OllamaMessage[]
  {
    const messages: OllamaMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
    ]

    for (let i = 0; i < turns; i++)
    {
      messages.push({ role: 'user', content: `Question ${i + 1}` })
      messages.push({
        role: 'assistant',
        content: `Answer ${i + 1}. `.repeat(80),
      })
    }

    return messages
  }

  test('splitForCompaction splits the live region and never touches the prefix', () =>
  {
    const messages = buildConversation(15)
    const config: CompactionConfig = {
      contextWindow: 4_000,
      minRecentMessages: 6,
      minMessagesForCompaction: 10,
    }

    // keep the system message outside both halves of the live region
    const { toSummarize, toKeep } = splitForCompaction(messages, config, 1)

    assert.ok(!toSummarize.some((message) => message.role === 'system'))
    assert.ok(!toKeep.some((message) => message.role === 'system'))
    assert.equal(toSummarize.length + toKeep.length, messages.length - 1)
    assert.ok(toKeep.length >= 6)
  })

  test('splitForCompaction holds out an extended frozen prefix', () =>
  {
    const config: CompactionConfig = {
      contextWindow: 4_000,
      minRecentMessages: 2,
      minMessagesForCompaction: 4,
    }
    const messages: OllamaMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `${FROZEN_SUMMARY_MARKER} ...]\n\nsummary 1` },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]

    // exclude the system message & prior summary from both halves
    const { toSummarize, toKeep } = splitForCompaction(messages, config, 2)

    assert.ok(
      !toSummarize.some((m) => m.content.startsWith(FROZEN_SUMMARY_MARKER))
    )
    assert.equal(toSummarize.length + toKeep.length, messages.length - 2)
  })

  test('buildCompactionPrompt creates a useful handoff without huge tool output', () =>
  {
    const longOutput = 'x'.repeat(1000)
    const messages: OllamaMessage[] = [
      { role: 'user', content: 'Read package.json' },
      {
        role: 'assistant',
        content: "I'll read it.",
        tool_calls: [
          {
            function: { name: 'read_file', arguments: { path: 'package.json' } },
          },
        ],
      },
      { role: 'tool', tool_name: 'read_file', content: longOutput },
      { role: 'assistant', content: 'The package is named coral.' },
    ]

    const prompt = buildCompactionPrompt(messages)

    assert.match(prompt, /## Goal/)
    assert.match(prompt, /## Work Completed/)
    assert.match(prompt, /read_file/)
    assert.match(prompt, /package is named coral/)
    assert.ok(!prompt.includes(longOutput))
  })

  test('buildCompactedMessages appends the summary after the frozen prefix', () =>
  {
    const system: OllamaMessage = { role: 'system', content: 'You are Coral.' }
    const toKeep: OllamaMessage[] = [
      { role: 'user', content: 'Now fix the bug' },
      { role: 'assistant', content: "I'll fix it." },
    ]

    const compacted = buildCompactedMessages(
      [system],
      '- Read the repo\n- Found the bug',
      toKeep
    )

    assert.equal(
      compacted.filter((message) => message.role === 'system').length,
      1
    )
    assert.equal(compacted[0]!.content, 'You are Coral.')
    assert.match(compacted[1]!.content, /Conversation handoff/)
    assert.equal(compacted[2]!.content, 'Now fix the bug')
    assert.equal(compacted[3]!.content, "I'll fix it.")
  })

  test('countFrozenPrefix counts system plus contiguous summary blocks', () =>
  {
    const messages: OllamaMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `${FROZEN_SUMMARY_MARKER} ...]\n\nsummary 1` },
      { role: 'user', content: `${FROZEN_SUMMARY_MARKER} ...]\n\nsummary 2` },
      { role: 'user', content: 'a normal question' },
      { role: 'assistant', content: 'answer' },
    ]

    assert.equal(countFrozenPrefix(messages), 3)
  })

  test('successive append compactions keep the frozen prefix byte-stable', () =>
  {
    const system: OllamaMessage = { role: 'system', content: 'You are Coral.' }
    const config: CompactionConfig = {
      contextWindow: 4_000,
      minRecentMessages: 2,
      minMessagesForCompaction: 4,
    }

    const turn = (n: number): OllamaMessage[] => [
      { role: 'user', content: `q${n}` },
      { role: 'assistant', content: `a${n}` },
    ]

    // append a summary after the system prompt
    let messages: OllamaMessage[] = [system, ...turn(1), ...turn(2), ...turn(3)]
    const split1 = splitForCompaction(messages, config, 1)
    messages = buildCompactedMessages(
      messages.slice(0, 1),
      'summary one',
      split1.toKeep
    )
    const fplAfterFirst = 2
    const prefixAfterFirst = messages.slice(0, fplAfterFirst)
    assert.equal(countFrozenPrefix(messages), fplAfterFirst)

    // append another summary without changing the existing prefix
    messages = [...messages, ...turn(4), ...turn(5)]
    const split2 = splitForCompaction(messages, config, fplAfterFirst)
    messages = buildCompactedMessages(
      messages.slice(0, fplAfterFirst),
      'summary two',
      split2.toKeep
    )

    // stable prefix bytes allow the KV cache to survive the second compaction
    assert.deepEqual(messages.slice(0, fplAfterFirst), prefixAfterFirst)
    assert.equal(countFrozenPrefix(messages), 3)
    assert.equal(messages[0]!.content, 'You are Coral.')
  })

  test('consolidation collapses capped summary blocks back into one', () =>
  {
    const config: CompactionConfig = {
      contextWindow: 4_000,
      minRecentMessages: 2,
      minMessagesForCompaction: 4,
    }

    // seed a capped prefix so compaction must consolidate it
    const system: OllamaMessage = { role: 'system', content: 'You are Coral.' }
    const summaries: OllamaMessage[] = Array.from(
      { length: MAX_FROZEN_SUMMARIES },
      (_unused, i) => ({
        role: 'user' as const,
        content: `${FROZEN_SUMMARY_MARKER} ...]\n\nsummary ${i + 1}`,
      })
    )
    const messages: OllamaMessage[] = [
      system,
      ...summaries,
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]

    // start from the system message so capped summaries are re-summarized
    const frozenPrefixLength = countFrozenPrefix(messages)
    assert.equal(frozenPrefixLength - 1 >= MAX_FROZEN_SUMMARIES, true)

    const { toSummarize, toKeep } = splitForCompaction(messages, config, 1)

    assert.ok(
      toSummarize.some((m) => m.content.startsWith(FROZEN_SUMMARY_MARKER))
    )

    const consolidated = buildCompactedMessages(
      messages.slice(0, 1),
      'one consolidated summary',
      toKeep
    )

    // consolidation bounds the prefix at one summary block
    assert.equal(countFrozenPrefix(consolidated), 2)
    assert.equal(consolidated[0]!.content, 'You are Coral.')
    assert.match(consolidated[1]!.content, /Conversation handoff/)
  })

  test('pruneToolResults removes old large tool results but keeps recent ones', () =>
  {
    const messages: OllamaMessage[] = [
      { role: 'system', content: 'System.' },
      { role: 'tool', tool_name: 'read_file', content: 'old file '.repeat(80) },
      { role: 'user', content: 'Q2' },
      { role: 'tool', tool_name: 'bash', content: 'recent output' },
    ]

    const { prunedMessages, prunedCount } = pruneToolResults(messages, 1)

    assert.equal(prunedCount, 1)
    assert.match(prunedMessages[1]!.content, /tool result pruned/)
    assert.equal(prunedMessages[3]!.content, 'recent output')
  })

  test('stripThinkingForCompaction removes reasoning while preserving answers', () =>
  {
    const messages: OllamaMessage[] = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'The answer is 42.',
        thinking: 'Private reasoning',
      },
    ]

    const stripped = stripThinkingForCompaction(messages)

    assert.equal(stripped[0]!.content, 'Hello')
    assert.equal(stripped[1]!.thinking, undefined)
    assert.match(stripped[1]!.content, /\[reasoning was used\]/)
    assert.match(stripped[1]!.content, /The answer is 42\./)
  })
})
