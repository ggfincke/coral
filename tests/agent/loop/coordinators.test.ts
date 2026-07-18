// tests/agent/loop/coordinators.test.ts
// causal tests for compaction coordination and request fallback order

import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import type { AgentInferenceClient } from '../../../src/agent/inference-client.js'
import {
  CompactionCoordinator,
  type CompactionRuntime,
} from '../../../src/agent/loop/compactor.js'
import {
  RequestPlanner,
  type ModelRequestPlan,
} from '../../../src/agent/loop/request-planner.js'
import type { AttachmentCapture } from '../../../src/agent/request/attachments.js'
import {
  estimateModelRequestMessagesTokens,
  estimateModelRequestToolTokens,
  estimateRequestFramingTokens,
} from '../../../src/agent/request/projection.js'
import type { CompactionResult } from '../../../src/agent/state/compaction.js'
import { ConversationState } from '../../../src/agent/state/conversation.js'
import type { OllamaMessage, OllamaTool } from '../../../src/types/inference.js'

describe('CompactionCoordinator', () =>
{
  const runtime: CompactionRuntime = {
    model: 'test-model',
    contextWindow: 8_192,
    numCtx: 8_192,
    toolDefinitionTokens: 17,
  }

  function populateState(state: ConversationState, label: string): void
  {
    state.restoreMessages([
      { role: 'user', content: `${label} user ${'u'.repeat(1_000)}` },
      { role: 'assistant', content: `${label} answer ${'a'.repeat(1_000)}` },
      { role: 'user', content: `${label} follow-up ${'f'.repeat(1_000)}` },
      { role: 'assistant', content: `${label} final ${'z'.repeat(1_000)}` },
    ])
  }

  test('CompactionCoordinator preserves callback, revision, and manual isolation', async () =>
  {
    const order: string[] = []
    let stream = 0
    const client: AgentInferenceClient = {
      startKeepAlive()
      {},
      async showModel()
      {
        return { contextLength: 8_192 }
      },
      async listModels()
      {
        return []
      },
      async *chatStream()
      {
        stream += 1
        order.push(`transport:${stream}`)
        yield {
          message: { role: 'assistant', content: `summary ${stream}` },
          done: true,
        }
      },
    }
    const state = new ConversationState('system')
    const coordinator = new CompactionCoordinator(state, client, {
      contextWindow: 100,
      minRecentMessages: 2,
      minMessagesForCompaction: 4,
    })
    populateState(state, 'first')

    const beforeTokens = state.getEstimatedTokens()
    const beforeMessages = state.getMessageCount()
    let result: CompactionResult | undefined
    await coordinator.compactIfNeeded({
      runtime,
      callbacks: {
        onStart: () => order.push('start:1'),
        onResult: (value) =>
        {
          order.push('result:1')
          result = value
        },
      },
    })

    assert.deepEqual(order, ['start:1', 'transport:1', 'result:1'])
    assert.ok(result)
    assert.equal(
      result.beforeTokens,
      beforeTokens +
        runtime.toolDefinitionTokens +
        estimateRequestFramingTokens(beforeMessages)
    )
    assert.equal(
      result.afterTokens,
      state.getEstimatedTokens() +
        runtime.toolDefinitionTokens +
        estimateRequestFramingTokens(state.getMessageCount())
    )
    assert.equal(state.getCompactionMetrics().successfulCount, 1)

    populateState(state, 'stale')
    order.length = 0
    await coordinator.compactIfNeeded({
      runtime,
      callbacks: {
        onStart: () =>
        {
          order.push('start:2')
          state.appendMessage({
            role: 'user',
            content: 'concurrent state drift',
          })
        },
        onResult: () => order.push('result:2'),
      },
    })

    assert.deepEqual(order, ['start:2', 'transport:2'])
    assert.equal(state.getMessages().at(-1)?.content, 'concurrent state drift')
    assert.equal(state.getCompactionMetrics().successfulCount, 1)

    populateState(state, 'manual')
    order.length = 0
    const manual = await coordinator.forceCompact(runtime)

    assert.equal(manual?.type, 'summarized')
    assert.deepEqual(order, ['transport:3'])
    assert.equal(state.getCompactionMetrics().successfulCount, 2)
  })
})

describe('RequestPlanner', () =>
{
  const CONTEXT_WINDOW = 8_192
  const BASE_SYSTEM = 'base system'
  const CLEAN_TURN = 'inspect this request'
  const TOOLS: readonly OllamaTool[] = []

  function prepared(plan: ModelRequestPlan)
  {
    assert.equal(plan.kind, 'prepared')
    if (plan.kind !== 'prepared') throw new Error('request was not prepared')
    return plan.request
  }

  function plan(
    input: {
      systemContent?: string
      gitContext?: OllamaMessage | null
      attachmentCapture?: AttachmentCapture
      historyCompactionAvailable?: boolean
    } = {}
  )
  {
    const planner = new RequestPlanner()
    return planner.planModelRequest({
      contextWindow: CONTEXT_WINDOW,
      storedMessages: [
        { role: 'system', content: input.systemContent ?? BASE_SYSTEM },
        { role: 'user', content: CLEAN_TURN },
      ],
      activeIndex: 1,
      cleanActiveContent: CLEAN_TURN,
      baseSystemContent: BASE_SYSTEM,
      tools: TOOLS,
      gitContext: input.gitContext ?? null,
      ...(input.attachmentCapture
        ? {
            pendingAttachments: {
              capture: input.attachmentCapture,
              maxChars: 50_000,
            },
          }
        : {}),
      historyCompactionAvailable: input.historyCompactionAvailable ?? true,
    })
  }

  test('RequestPlanner preserves fallback priority and exact allowance math', () =>
  {
    const smallGit: OllamaMessage = {
      role: 'system',
      content: '## Git Context\n- branch: main\n- status: clean',
    }
    const retained = prepared(plan({ gitContext: smallGit }))
    assert.equal(retained.messages.at(-1)!.content, smallGit.content)

    const fullGit: OllamaMessage = {
      role: 'system',
      content: [
        '## Git Context',
        '- root: /repo',
        '- cwd: /repo',
        '- branch: main',
        '- status: modified',
        `- detail: ${'d'.repeat(40_000)}`,
      ].join('\n'),
    }
    const compacted = prepared(plan({ gitContext: fullGit }))
    assert.match(compacted.messages.at(-1)!.content, /detail: omitted/)
    assert.notEqual(compacted.messages.at(-1)!.content, fullGit.content)

    const oversizedCompactGit: OllamaMessage = {
      role: 'system',
      content: [
        '## Git Context',
        '- root: /repo',
        '- cwd: /repo',
        '- branch: main',
        `- status: ${'s'.repeat(40_000)}`,
        '- detail: changed files',
      ].join('\n'),
    }
    const omitted = prepared(plan({ gitContext: oversizedCompactGit }))
    assert.equal(omitted.messages.length, 2)

    const reducedSystem = prepared(
      plan({ systemContent: `${BASE_SYSTEM}\n${'p'.repeat(40_000)}` })
    )
    assert.equal(reducedSystem.systemContent, BASE_SYSTEM)
    assert.equal(reducedSystem.messages[0]!.content, BASE_SYSTEM)

    const attachmentCapture: AttachmentCapture = {
      entries: [
        {
          status: 'captured',
          path: 'large.txt',
          resolvedPath: '/repo/large.txt',
          content: 'a'.repeat(40_000),
        },
      ],
    }
    const beforeHardFit = plan({ attachmentCapture })
    assert.equal(beforeHardFit.kind, 'needs_history_compaction')

    const afterHardFit = prepared(
      plan({
        attachmentCapture,
        historyCompactionAvailable: false,
      })
    )
    assert.equal(afterHardFit.budget.fits, true)
    assert.ok(afterHardFit.attachmentCommit)
    assert.equal(
      afterHardFit.messages[1]!.content,
      afterHardFit.attachmentCommit.content
    )
    assert.ok(afterHardFit.attachmentCommit.materialization.usedChars < 40_000)

    const actualPromptTokens =
      estimateModelRequestMessagesTokens(afterHardFit.messages) +
      estimateModelRequestToolTokens(TOOLS) +
      estimateRequestFramingTokens(afterHardFit.messages.length)
    assert.equal(actualPromptTokens, afterHardFit.budget.promptTokens)

    const planner = new RequestPlanner()
    const assistantMessage: OllamaMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: 'first', arguments: {} } },
        { function: { name: 'second', arguments: {} } },
      ],
    }
    const minimumResultMessages: OllamaMessage[] = [
      { role: 'tool', tool_name: 'first', content: 'Error: omitted' },
      { role: 'tool', tool_name: 'second', content: 'Error: omitted' },
    ]
    const reservation = planner.reserveToolResults({
      contextWindow: CONTEXT_WINDOW,
      storedMessages: [
        { role: 'system', content: BASE_SYSTEM },
        { role: 'user', content: CLEAN_TURN },
      ],
      activeIndex: 1,
      cleanActiveContent: CLEAN_TURN,
      baseSystemContent: BASE_SYSTEM,
      tools: TOOLS,
      assistantMessage,
      minimumResultMessages,
      historyCompactionAvailable: true,
    })
    assert.equal(reservation.kind, 'prepared')
    if (reservation.kind !== 'prepared')
    {
      throw new Error('tool-result allowance was not prepared')
    }
    assert.equal(reservation.reservation.allowance.minimumTokens.length, 2)
    assert.ok(
      reservation.reservation.allowance.remainingTokens >=
        reservation.reservation.allowance.minimumTokens.reduce(
          (total, tokens) => total + tokens,
          0
        )
    )
    assert.equal(Object.isFrozen(reservation.reservation.allowance), true)
    assert.equal(
      Object.isFrozen(reservation.reservation.allowance.minimumTokens),
      true
    )
  })
})
