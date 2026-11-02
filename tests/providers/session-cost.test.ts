// tests/providers/session-cost.test.ts
// protect provider billing math and complete session inference accounting

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { Response as OpenAIResponse } from 'openai/resources/responses/responses'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { billingUsageFrom as openAIUsage } from '../../src/providers/openai/wire.js'
import { billingUsageFrom as anthropicUsage } from '../../src/providers/anthropic/wire.js'
import { OpenAIClient } from '../../src/providers/openai/client.js'
import { AnthropicClient } from '../../src/providers/anthropic/client.js'
import { estimateRequestCost } from '../../src/providers/pricing.js'
import {
  SessionCostTracker,
  SessionInferenceClient,
} from '../../src/agent/session-cost.js'
import type { AgentInferenceClient } from '../../src/agent/inference-client.js'
import { Agent } from '../../src/agent/agent.js'
import { taskTool } from '../../src/tools/task.js'
import { requestSessionTitle } from '../../src/tui/session/agent-session.js'
import type { BillingUsage } from '../../src/types/session-cost.js'
import type { ChatResponse } from '../../src/types/inference.js'
import { makeAgentEvents } from '../helpers/agent-harness.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { withFetch } from '../helpers/fetch.js'

const { tempDir } = makeTempDirPool()
const openAIResponse = {
  id: 'resp_fixture',
  model: 'gpt-6.1-sol',
  object: 'response',
  status: 'completed',
  output: [],
  service_tier: 'default',
  usage: {
    input_tokens: 1000,
    output_tokens: 50,
    total_tokens: 1050,
    input_tokens_details: {
      cached_tokens: 200,
      cache_write_tokens: 300,
      cache_write_tokens_details: { ttl_30m_tokens: 200, ttl_12h_tokens: 100 },
    },
    output_tokens_details: { reasoning_tokens: 20 },
  },
} as unknown as OpenAIResponse
const anthropicMessage = {
  id: 'msg_fixture',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 500,
    output_tokens: 50,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 300,
    cache_creation: {
      ephemeral_5m_input_tokens: 200,
      ephemeral_1h_input_tokens: 100,
    },
    service_tier: 'standard',
    speed: 'standard',
  },
} as unknown as BetaMessage

function near(actual: number | undefined, expected: number): void
{
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-12,
    `${actual} != ${expected}`
  )
}

function transport(
  stream: AgentInferenceClient['chatStream']
): AgentInferenceClient
{
  return {
    startKeepAlive()
    {},
    showModel: async () => ({
      contextLength: 200_000,
      hosted: { maxOutputTokens: 1000 },
    }),
    listModels: async () => [],
    chatStream: stream,
  }
}

function billed(usage: BillingUsage): ChatResponse
{
  return {
    message: { role: 'assistant', content: '' },
    done: false,
    billingUsage: usage,
  }
}

test('billing normalization prices cache lifetimes and inclusive output without double counting', () =>
{
  const openai = openAIUsage(openAIResponse)!
  const anthropic = anthropicUsage(anthropicMessage)
  assert.deepEqual(openai, {
    model: 'openai/gpt-6.1-sol',
    serviceTier: 'default',
    inputTokens: 500,
    outputTokens: 50,
    cacheReadTokens: 200,
    cacheWriteShortTokens: 200,
    cacheWriteLongTokens: 100,
  })
  near(estimateRequestCost(openai), 0.00252)
  near(estimateRequestCost(anthropic), 0.00484)
  near(estimateRequestCost({ ...openai, serviceTier: 'fast' }), 0.00504)
  near(
    estimateRequestCost({
      ...openai,
      inputTokens: 272001,
      cacheReadTokens: 0,
      cacheWriteShortTokens: 0,
      cacheWriteLongTokens: 0,
      outputTokens: 100,
    }),
    1.089504
  )
  near(
    estimateRequestCost({
      ...anthropic,
      model: 'anthropic/claude-haiku-5-5',
      inputTokens: 100001,
      cacheReadTokens: 0,
      cacheWriteShortTokens: 0,
      cacheWriteLongTokens: 0,
      outputTokens: 100,
    }),
    0.0502505
  )
  assert.equal(
    estimateRequestCost({ ...openai, model: 'openai/gpt-future' }),
    undefined
  )
  assert.equal(
    estimateRequestCost({ ...openai, serviceTier: 'unknown' }),
    undefined
  )
})

test('the session boundary records unknown usage, unpriced models, and known rejection separately', async () =>
{
  const costs = new SessionCostTracker()
  const usage = openAIUsage(openAIResponse)!
  const client = new SessionInferenceClient(
    transport(async function* (request)
    {
      if (request.model.endsWith('reject'))
      {
        yield {
          message: { role: 'assistant', content: '' },
          done: false,
          billingRejected: true,
        }
        throw new Error('rejected')
      }
      if (request.model.endsWith('interrupt'))
      {
        yield {
          message: { role: 'assistant', content: 'partial' },
          done: false,
        }
        throw new Error('connection interrupted')
      }
      yield {
        ...billed({ ...usage, model: request.model }),
        done: true,
        message: { role: 'assistant', content: 'answer' },
      }
    }),
    costs
  )
  const run = async (model: string) =>
  {
    const chunks: ChatResponse[] = []
    for await (const chunk of client.chatStream({ model, messages: [] }))
      chunks.push(chunk)
    return chunks
  }
  assert.equal((await run('openai/gpt-6.1-sol'))[0]!.message.content, 'answer')
  await run('openai/gpt-future')
  await assert.rejects(run('openai/interrupt'), /interrupted/)
  await assert.rejects(run('openai/reject'), /rejected/)
  await run('local-model')
  const snapshot = costs.snapshot()
  assert.equal(snapshot.entries.length, 3)
  assert.equal(snapshot.entries[1]!.unpricedRequests, 1)
  assert.equal(snapshot.entries[2]!.missingUsageRequests, 1)
  near(snapshot.entries[0]!.usd, 0.00252)
})

test('real SDK adapters account for a paid refusal before reporting semantic errors', async () =>
{
  const settings = {
    apiKey: 'test-key',
    effort: 'high' as const,
    maxContextTokens: 200_000,
  }
  const openai = {
    ...openAIResponse,
    output: [
      {
        type: 'message',
        id: 'msg_refusal',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'refusal', refusal: 'fixture refusal' }],
      },
    ],
  }
  const anthropic = { ...anthropicMessage, stop_reason: 'refusal' }
  await withFetch(
    (input) =>
    {
      const isOpenAI = String(input).includes('api.openai.com')
      const events = isOpenAI
        ? [
            {
              type: 'response.created',
              response: { ...openai, output: [], status: 'in_progress' },
            },
            { type: 'response.completed', response: openai },
          ]
        : [
            {
              type: 'message_start',
              message: { ...anthropic, stop_reason: null },
            },
            {
              type: 'message_delta',
              delta: { stop_reason: 'refusal', stop_sequence: null },
              usage: { output_tokens: 50 },
            },
            { type: 'message_stop' },
          ]
      const text = events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        )
        .join('')
      return new Response(text, {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
    async () =>
    {
      for (const [model, raw, expected] of [
        ['openai/gpt-6.1-sol', new OpenAIClient(settings), 0.00252],
        ['anthropic/claude-opus-5-5', new AnthropicClient(settings), 0.00484],
      ] as const)
      {
        const costs = new SessionCostTracker()
        const routed = new SessionInferenceClient(
          transport(async function* (request, signal)
          {
            yield* raw.chatStream(
              { ...request, model: request.model.split('/')[1]! },
              signal
            )
          }),
          costs
        )
        await assert.rejects(async () =>
        {
          for await (const chunk of routed.chatStream({ model, messages: [] }))
            void chunk
        }, /refus|declined/)
        near(costs.snapshot().entries[0]!.usd, expected)
        assert.equal(costs.snapshot().entries[0]!.missingUsageRequests, 0)
      }
    }
  )
})

test('main rounds, borrowed subagents, compaction, and titles charge the primary exactly once', async () =>
{
  const cwd = await tempDir('coral-cost-accounting-')
  let requests = 0
  const usage = anthropicUsage(anthropicMessage)
  const client = transport(async function* ()
  {
    requests++
    yield billed(usage)
    if (requests === 1)
    {
      yield {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'task',
                arguments: { prompt: 'inspect fixture' },
              },
            },
          ],
        },
        done: true,
      }
    }
    else
      yield {
        message: { role: 'assistant', content: 'Fixture summary' },
        done: true,
      }
  })
  const agent = new Agent('anthropic/claude-opus-5-5', undefined, cwd, {
    inferenceClient: client,
    tools: [taskTool],
    mcpMode: 'off',
    permissions: { task: 'always_allow' },
    verifyEdits: false,
  })
  try
  {
    await agent.run('research fixture', makeAgentEvents())
    assert.equal(requests, 3)
    near(agent.getSessionCost().entries[0]!.usd, 3 * 0.00484)
    agent.restoreMessages(
      Array.from({ length: 6 }, (_, index) => [
        { role: 'user' as const, content: `question ${index}` },
        { role: 'assistant' as const, content: `answer ${index}` },
      ]).flat()
    )
    assert.equal((await agent.forceCompact())?.type, 'summarized')
    assert.equal(
      await requestSessionTitle(
        agent.getSessionInferenceClient(),
        agent.getModel(),
        { user: 'question', assistant: 'answer' }
      ),
      'Fixture summary'
    )
    assert.equal(requests, 5)
    assert.equal(agent.getSessionCost().entries[0]!.requests, 5)
    near(agent.getSessionCost().entries[0]!.usd, 5 * 0.00484)
  }
  finally
  {
    await agent.dispose()
  }
})
