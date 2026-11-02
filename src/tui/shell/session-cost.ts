// src/tui/shell/session-cost.ts
// format estimated costs consistently across footer and status

import type { SessionCostSnapshot } from '../../types/session-cost.js'
import { sanitizeUntrustedText } from '../transcript/sanitize.js'

export function formatCostAmount(usd: number): string
{
  return usd > 0 && usd < 0.01 ? '<$0.01' : `~$${usd.toFixed(2)}`
}

export function formatSessionCost(
  snapshot: SessionCostSnapshot
): string | undefined
{
  if (snapshot.entries.length === 0) return undefined
  let usd = 0
  let priced = 0
  let partial = snapshot.historicalUsageUnknown
  for (const entry of snapshot.entries)
  {
    usd += entry.usd
    priced +=
      entry.requests - entry.unpricedRequests - entry.missingUsageRequests
    partial ||= entry.unpricedRequests > 0 || entry.missingUsageRequests > 0
  }
  if (priced === 0) return 'cost unknown'
  return `${formatCostAmount(usd)}${partial ? '+' : ''}`
}

export function sessionCostStatusLines(
  snapshot: SessionCostSnapshot
): string[]
{
  const total = formatSessionCost(snapshot)
  if (!total && !snapshot.historicalUsageUnknown) return []
  const lines = [`  Session cost (USD, est): ${total ?? 'cost unknown'}`]
  for (const provider of ['anthropic', 'openai'])
  {
    const entries = snapshot.entries.filter((entry) =>
      entry.model.startsWith(`${provider}/`)
    )
    if (entries.length === 0) continue
    const subtotal = formatSessionCost({
      ...snapshot,
      historicalUsageUnknown: false,
      entries,
    })
    lines.push(`    ${provider}: ${subtotal}`)
    for (const entry of entries)
    {
      const amount = formatSessionCost({
        ...snapshot,
        historicalUsageUnknown: false,
        entries: [entry],
      })
      const tokens = entry.tokens
      const requests = `${entry.requests} request${entry.requests === 1 ? '' : 's'}`
      lines.push(
        `      ${sanitizeUntrustedText(entry.model)} (${sanitizeUntrustedText(entry.serviceTier)}): ${amount} · ${requests}`,
        `        input ${tokens.inputTokens}, output ${tokens.outputTokens}, cache read ${tokens.cacheReadTokens}, short write ${tokens.cacheWriteShortTokens}, long write ${tokens.cacheWriteLongTokens}`
      )
      if (entry.unpricedRequests > 0)
        lines.push(
          `        ${entry.unpricedRequests} request(s) with unavailable model/tier pricing`
        )
      if (entry.missingUsageRequests > 0)
        lines.push(
          `        ${entry.missingUsageRequests} request(s) with missing usage; charges unknown`
        )
    }
  }
  if (snapshot.historicalUsageUnknown)
  {
    lines.push(
      `    Tracked since this update (${snapshot.trackingStartedAt}); earlier spending is unknown.`
    )
  }
  return lines
}
