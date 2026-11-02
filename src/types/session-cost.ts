// src/types/session-cost.ts
// provider billing usage and durable session cost values

export interface BillingTokens
{
  inputTokens: number
  cacheReadTokens: number
  cacheWriteShortTokens: number
  cacheWriteLongTokens: number
  outputTokens: number
}

export interface BillingUsage extends BillingTokens
{
  model: string
  serviceTier: string
}

export interface SessionCostEntry
{
  model: string
  serviceTier: string
  usd: number
  requests: number
  unpricedRequests: number
  missingUsageRequests: number
  tokens: BillingTokens
}

export interface SessionCostSnapshot
{
  version: 1
  currency: 'USD'
  trackingStartedAt: string
  historicalUsageUnknown: boolean
  entries: SessionCostEntry[]
}
