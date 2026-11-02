// src/agent/session-cost.ts
// accumulate session spending once at the inference boundary

import type { AgentInferenceClient } from './inference-client.js'
import type { ChatRequest, ChatResponse } from '../types/inference.js'
import type {
  BillingTokens,
  BillingUsage,
  SessionCostEntry,
  SessionCostSnapshot,
} from '../types/session-cost.js'
import { estimateRequestCost } from '../providers/pricing.js'
import { parseModelRef } from '../providers/model-ref.js'

function emptyTokens(): BillingTokens
{
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteShortTokens: 0,
    cacheWriteLongTokens: 0,
    outputTokens: 0,
  }
}

export class SessionCostTracker
{
  private state: SessionCostSnapshot
  private readonly listeners = new Set<() => void>()

  constructor(snapshot?: SessionCostSnapshot, historicalUsageUnknown = false)
  {
    this.state = snapshot
      ? structuredClone(snapshot)
      : {
          version: 1,
          currency: 'USD',
          trackingStartedAt: new Date().toISOString(),
          historicalUsageUnknown,
          entries: [],
        }
  }

  snapshot(): SessionCostSnapshot
  {
    return structuredClone(this.state)
  }

  subscribe(listener: () => void): () => void
  {
    this.listeners.add(listener)
    return () =>
    {
      this.listeners.delete(listener)
    }
  }

  reset(): void
  {
    this.state = new SessionCostTracker().snapshot()
    this.publish()
  }

  record(usage: BillingUsage): void
  {
    const counts = [
      usage.inputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteShortTokens,
      usage.cacheWriteLongTokens,
      usage.outputTokens,
    ]
    if (counts.some((value) => !Number.isSafeInteger(value) || value < 0))
    {
      this.recordMissing(usage.model)
      return
    }
    const entry = this.entry(usage.model, usage.serviceTier)
    entry.requests++
    const cost = estimateRequestCost(usage)
    if (cost === undefined) entry.unpricedRequests++
    else entry.usd += cost
    for (const key of Object.keys(entry.tokens) as (keyof BillingTokens)[])
    {
      entry.tokens[key] += usage[key]
    }
    this.publish()
  }

  recordMissing(model: string): void
  {
    const entry = this.entry(model, 'unknown')
    entry.requests++
    entry.missingUsageRequests++
    this.publish()
  }

  private entry(model: string, serviceTier: string): SessionCostEntry
  {
    let entry = this.state.entries.find(
      (value) => value.model === model && value.serviceTier === serviceTier
    )
    if (!entry)
    {
      entry = {
        model,
        serviceTier,
        usd: 0,
        requests: 0,
        unpricedRequests: 0,
        missingUsageRequests: 0,
        tokens: emptyTokens(),
      }
      this.state.entries.push(entry)
    }
    return entry
  }

  private publish(): void
  {
    for (const listener of this.listeners) listener()
  }
}

// children borrow this same wrapper, so nested Agent construction never meters twice
export class SessionInferenceClient implements AgentInferenceClient
{
  constructor(
    private readonly client: AgentInferenceClient,
    readonly costs: SessionCostTracker
  )
  {}

  startKeepAlive(model: string): void
  {
    this.client.startKeepAlive(model)
  }

  showModel(model: string, signal?: AbortSignal)
  {
    return this.client.showModel(model, signal)
  }

  listModels(signal?: AbortSignal)
  {
    return this.client.listModels(signal)
  }

  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatResponse>
  {
    if (signal?.aborted) return
    const hosted = parseModelRef(request.model).provider !== 'ollama'
    let accounted = false
    let rejected = false
    try
    {
      for await (const chunk of this.client.chatStream(request, signal))
      {
        if (hosted && chunk.billingUsage && !accounted)
        {
          accounted = true
          this.costs.record(chunk.billingUsage)
        }
        rejected ||= Boolean(chunk.billingRejected)
        const { billingUsage, billingRejected, ...response } = chunk
        if (
          (billingUsage || billingRejected) &&
          !chunk.done &&
          !chunk.message.content &&
          !chunk.message.thinking &&
          !chunk.message.tool_calls?.length
        )
          continue
        yield response
      }
    }
    finally
    {
      if (hosted && !accounted && !rejected)
        this.costs.recordMissing(request.model)
    }
  }
}
