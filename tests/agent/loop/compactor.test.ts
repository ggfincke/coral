// tests/agent/loop/compactor.test.ts
// causal tests for compaction coordination and callback timing

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AgentInferenceClient } from '../../../src/agent/inference-client.js'
import {
  CompactionCoordinator,
  type CompactionRuntime,
} from '../../../src/agent/loop/compactor.js'
import { estimateRequestFramingTokens } from '../../../src/agent/request/projection.js'
import type { CompactionResult } from '../../../src/agent/state/compaction.js'
import { ConversationState } from '../../../src/agent/state/conversation.js'

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
        state.appendMessage({ role: 'user', content: 'concurrent state drift' })
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
