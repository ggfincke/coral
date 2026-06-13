// src/tui/metrics.ts
// shared token, throughput, & duration formatting for TUI surfaces

export function formatElapsed(ms: number): string
{
  if (ms < 60_000)
  {
    return `${(ms / 1000).toFixed(1)}s`
  }

  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

export function formatTokenCount(tokens: number): string
{
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

// sub-second precision in ms, otherwise delegate to formatElapsed (floors seconds)
export function formatDurationNs(ns: number): string
{
  const ms = ns / 1e6
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  return formatElapsed(ms)
}

export function computeTokensPerSecond(
  tokens: number,
  durationNs: number | undefined
): number
{
  if (!tokens || !durationNs || durationNs <= 0) return 0
  return tokens / (durationNs / 1e9)
}

export function formatTokensPerSecond(tps: number): string
{
  if (tps <= 0) return ''
  if (tps >= 100) return `${Math.round(tps)} tok/s`
  return `${tps.toFixed(1)} tok/s`
}

export function buildTokenGauge(
  totalTokens: number,
  contextWindow: number
): string
{
  if (totalTokens === 0 && contextWindow === 0) return ''

  const used = formatTokenCount(totalTokens)

  if (contextWindow > 0)
  {
    const window = formatTokenCount(contextWindow)
    const pct = Math.min(Math.round((totalTokens / contextWindow) * 100), 100)
    return `${used}/${window} ctx (${pct}%)`
  }

  return `${used} tokens`
}

// '<n> message(s)' w/ correct pluralization
export function pluralizeMessages(n: number): string
{
  return `${n} ${n === 1 ? 'message' : 'messages'}`
}
