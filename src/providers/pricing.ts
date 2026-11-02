// src/providers/pricing.ts
// published USD rates per million tokens, verified 2026-10-30

import type { BillingUsage } from '../types/session-cost.js'

// sources: developers.openai.com/api/docs/pricing
// & platform.claude.com/docs/en/about-claude/pricing
export const PRICING_AS_OF = '2026-10-30'

type Rates = readonly (number | null)[]
interface RateCard
{
  threshold?: number
  standard: Rates
  standardLong?: Rates
  batch?: Rates
  batchLong?: Rates
  flex?: Rates
  flexLong?: Rates
  fast?: Rates
  fastLong?: Rates
  ultrafast?: Rates
  ultrafastLong?: Rates
}

const OPENAI_RATES: Record<string, RateCard> = {
  'openai/gpt-6-astra': {
    threshold: 272_000,
    standard: [10, 50, 1, 12.5, 25],
    standardLong: [20, 75, 2, 25, 50],
    batch: [5, 25, 0.5, 6.25, 12.5],
    batchLong: [10, 37.5, 1, 12.5, 25],
    flex: [5, 25, 0.5, 6.25, 12.5],
    flexLong: [10, 37.5, 1, 12.5, 25],
    fast: [20, 100, 2, 25, 50],
    fastLong: [40, 150, 4, 50, 100],
    ultrafast: [60, 300, 6, 75, 150],
    ultrafastLong: [120, 450, 12, 150, 300],
  },
  'openai/gpt-6.1-sol': {
    threshold: 272_000,
    standard: [2, 10, 0.1, 2.5, 5],
    standardLong: [4, 15, 0.2, 5, 10],
    batch: [1, 5, 0.05, 1.25, 2.5],
    batchLong: [2, 7.5, 0.1, 2.5, 5],
    flex: [1, 5, 0.05, 1.25, 2.5],
    flexLong: [2, 7.5, 0.1, 2.5, 5],
    fast: [4, 20, 0.2, 5, 10],
    fastLong: [8, 30, 0.4, 10, 20],
    ultrafast: [12, 60, 0.6, 15, 30],
    ultrafastLong: [24, 90, 1.2, 30, 60],
  },
  'openai/gpt-6.1-terra': {
    threshold: 272_000,
    standard: [1, 5, 0.05, 1.25, 2.5],
    standardLong: [2, 7.5, 0.1, 2.5, 5],
    batch: [0.5, 2.5, 0.025, 0.625, 1.25],
    batchLong: [1, 3.75, 0.05, 1.25, 2.5],
    flex: [0.5, 2.5, 0.025, 0.625, 1.25],
    flexLong: [1, 3.75, 0.05, 1.25, 2.5],
    fast: [2, 10, 0.1, 2.5, 5],
    fastLong: [4, 15, 0.2, 5, 10],
  },
  'openai/gpt-6-luna': {
    threshold: 272_000,
    standard: [0.1, 0.5, 0.01, 0.125, 0.25],
    standardLong: [0.2, 0.75, 0.02, 0.25, 0.5],
    batch: [0.05, 0.25, 0.005, 0.0625, 0.125],
    batchLong: [0.1, 0.375, 0.01, 0.125, 0.25],
    flex: [0.05, 0.25, 0.005, 0.0625, 0.125],
    flexLong: [0.1, 0.375, 0.01, 0.125, 0.25],
    fast: [0.2, 1, 0.02, 0.25, 0.5],
    fastLong: [0.4, 1.5, 0.04, 0.5, 1],
  },
  'openai/gpt-6-sol': {
    threshold: 272_000,
    standard: [2, 10, 0.2, 2.5, 5],
    standardLong: [4, 15, 0.4, 5, 10],
    batch: [1, 5, 0.1, 1.25, 2.5],
    batchLong: [2, 7.5, 0.2, 2.5, 5],
    flex: [1, 5, 0.1, 1.25, 2.5],
    flexLong: [2, 7.5, 0.2, 2.5, 5],
    fast: [4, 20, 0.4, 5, 10],
    fastLong: [8, 30, 0.8, 10, 20],
  },
  'openai/gpt-5.6-sol': {
    threshold: 272_000,
    standard: [4, 20, 0.4, 5, 10],
    standardLong: [8, 30, 0.8, 10, 20],
    batch: [2, 10, 0.2, 2.5, 5],
    batchLong: [4, 15, 0.4, 5, 10],
    flex: [2, 10, 0.2, 2.5, 5],
    flexLong: [4, 15, 0.4, 5, 10],
    fast: [8, 40, 0.8, 10, 20],
    fastLong: [16, 60, 1.6, 20, 40],
  },
  'openai/gpt-5.6-terra': {
    threshold: 272_000,
    standard: [2, 12, 0.2, 2.5, 5],
    standardLong: [4, 18, 0.4, 5, 10],
    batch: [1, 6, 0.1, 1.25, 2.5],
    batchLong: [2, 9, 0.2, 2.5, 5],
    flex: [1, 6, 0.1, 1.25, 2.5],
    flexLong: [2, 9, 0.2, 2.5, 5],
    fast: [4, 24, 0.4, 5, 10],
    fastLong: [8, 36, 0.8, 10, 20],
  },
  'openai/gpt-5.6-luna': {
    threshold: 272_000,
    standard: [0.2, 1.2, 0.02, 0.25, 0.5],
    standardLong: [0.4, 1.8, 0.04, 0.5, 1],
    batch: [0.1, 0.6, 0.01, 0.125, 0.25],
    batchLong: [0.2, 0.9, 0.02, 0.25, 0.5],
    flex: [0.1, 0.6, 0.01, 0.125, 0.25],
    flexLong: [0.2, 0.9, 0.02, 0.25, 0.5],
    fast: [0.4, 2.4, 0.04, 0.5, 1],
    fastLong: [0.8, 3.6, 0.08, 1, 2],
  },
  'openai/gpt-5.5': {
    threshold: 272_000,
    standard: [5, 30, 0.5, null, null],
    standardLong: [10, 45, 1, null, null],
    batch: [2.5, 15, 0.25, null, null],
    batchLong: [5, 22.5, 0.5, null, null],
    flex: [2.5, 15, 0.25, null, null],
    flexLong: [5, 22.5, 0.5, null, null],
    fast: [12.5, 75, 1.25, null, null],
    fastLong: [null, null, null, null, null],
  },
  'openai/gpt-5.5-pro': {
    threshold: 272_000,
    standard: [30, 180, null, null, null],
    standardLong: [60, 270, null, null, null],
    batch: [15, 90, null, null, null],
    batchLong: [null, null, null, null, null],
    flex: [15, 90, null, null, null],
    flexLong: [null, null, null, null, null],
  },
  'openai/gpt-5.4': {
    threshold: 272_000,
    standard: [2.5, 15, 0.25, null, null],
    standardLong: [5, 22.5, 0.5, null, null],
    batch: [1.25, 7.5, 0.13, null, null],
    batchLong: [2.5, 11.25, 0.25, null, null],
    flex: [1.25, 7.5, 0.13, null, null],
    flexLong: [2.5, 11.25, 0.25, null, null],
    fast: [5, 30, 0.5, null, null],
    fastLong: [null, null, null, null, null],
  },
  'openai/gpt-5.4-pro': {
    threshold: 272_000,
    standard: [30, 180, null, null, null],
    standardLong: [60, 270, null, null, null],
    batch: [15, 90, null, null, null],
    batchLong: [30, 135, null, null, null],
    flex: [15, 90, null, null, null],
    flexLong: [30, 135, null, null, null],
  },
  'openai/gpt-5.4-mini': {
    standard: [0.75, 4.5, 0.075, null, null],
    batch: [0.375, 2.25, 0.0375, null, null],
    flex: [0.375, 2.25, 0.0375, null, null],
    fast: [1.5, 9, 0.15, null, null],
  },
  'openai/gpt-5.4-nano': {
    standard: [0.2, 1.25, 0.02, null, null],
    batch: [0.1, 0.625, 0.01, null, null],
    flex: [0.1, 0.625, 0.01, null, null],
  },
  'openai/gpt-5.2': {
    standard: [1.75, 14, 0.175, null, null],
    batch: [0.875, 7, 0.0875, null, null],
    flex: [0.875, 7, 0.0875, null, null],
    fast: [3.5, 28, 0.35, null, null],
  },
  'openai/gpt-5.2-pro': {
    standard: [21, 168, null, null, null],
    batch: [10.5, 84, null, null, null],
  },
  'openai/gpt-5.1': {
    standard: [1.25, 10, 0.125, null, null],
    batch: [0.625, 5, 0.0625, null, null],
    flex: [0.625, 5, 0.0625, null, null],
    fast: [2.5, 20, 0.25, null, null],
  },
  'openai/gpt-5': {
    standard: [1.25, 10, 0.125, null, null],
    batch: [0.625, 5, 0.0625, null, null],
    flex: [0.625, 5, 0.0625, null, null],
    fast: [2.5, 20, 0.25, null, null],
  },
  'openai/gpt-5-mini': {
    standard: [0.25, 2, 0.025, null, null],
    batch: [0.125, 1, 0.0125, null, null],
    flex: [0.125, 1, 0.0125, null, null],
    fast: [0.45, 3.6, 0.045, null, null],
  },
  'openai/gpt-5-nano': {
    standard: [0.05, 0.4, 0.005, null, null],
    batch: [0.025, 0.2, 0.0025, null, null],
    flex: [0.025, 0.2, 0.0025, null, null],
  },
  'openai/gpt-5-pro': {
    standard: [15, 120, null, null, null],
    batch: [7.5, 60, null, null, null],
  },
  'openai/gpt-4.1': {
    standard: [2, 8, 0.5, null, null],
    batch: [1, 4, null, null, null],
    fast: [3.5, 14, 0.875, null, null],
  },
  'openai/gpt-4.1-mini': {
    standard: [0.4, 1.6, 0.1, null, null],
    batch: [0.2, 0.8, null, null, null],
    fast: [0.7, 2.8, 0.175, null, null],
  },
  'openai/gpt-4.1-nano': {
    standard: [0.1, 0.4, 0.025, null, null],
    batch: [0.05, 0.2, null, null, null],
    fast: [0.2, 0.8, 0.05, null, null],
  },
  'openai/gpt-4o': {
    standard: [2.5, 10, 1.25, null, null],
    batch: [1.25, 5, null, null, null],
    fast: [4.25, 17, 2.125, null, null],
  },
  'openai/gpt-4o-2024-05-13': {
    standard: [5, 15, null, null, null],
    batch: [2.5, 7.5, null, null, null],
    fast: [8.75, 26.25, null, null, null],
  },
  'openai/gpt-4o-mini': {
    standard: [0.15, 0.6, 0.075, null, null],
    batch: [0.075, 0.3, null, null, null],
    fast: [0.25, 1, 0.125, null, null],
  },
  'openai/o1': {
    standard: [15, 60, 7.5, null, null],
    batch: [7.5, 30, null, null, null],
  },
  'openai/o1-pro': {
    standard: [150, 600, null, null, null],
    batch: [75, 300, null, null, null],
  },
  'openai/o3-pro': {
    standard: [20, 80, null, null, null],
    batch: [10, 40, null, null, null],
  },
  'openai/o3': {
    standard: [2, 8, 0.5, null, null],
    batch: [1, 4, null, null, null],
    flex: [1, 4, 0.25, null, null],
    fast: [3.5, 14, 0.875, null, null],
  },
  'openai/o4-mini': {
    standard: [1.1, 4.4, 0.275, null, null],
    batch: [0.55, 2.2, null, null, null],
    flex: [0.55, 2.2, 0.138, null, null],
    fast: [2, 8, 0.5, null, null],
  },
  'openai/o3-mini': {
    standard: [1.1, 4.4, 0.55, null, null],
    batch: [0.55, 2.2, null, null, null],
  },
  'openai/gpt-4-turbo-2024-04-09': {
    standard: [10, 30, null, null, null],
    batch: [5, 15, null, null, null],
  },
  'openai/gpt-4-0613': {
    standard: [30, 60, null, null, null],
    batch: [15, 30, null, null, null],
  },
  'openai/gpt-3.5-turbo': { standard: [0.5, 1.5, null, null, null] },
  'openai/gpt-3.5-turbo-0125': {
    standard: [0.5, 1.5, null, null, null],
    batch: [0.25, 0.75, null, null, null],
  },
}

function claude(input: number, output: number, read = input / 10): RateCard
{
  return { standard: [input, output, read, input * 1.25, input * 2] }
}

const ANTHROPIC_RATES: Record<string, RateCard> = {
  'anthropic/claude-fable-5-1': claude(10, 50, 0.25),
  'anthropic/claude-mythos-5-1': claude(10, 50, 0.25),
  'anthropic/claude-fable-5': claude(10, 50, 1),
  'anthropic/claude-mythos-5': claude(10, 50, 1),
  'anthropic/claude-opus-5-5': {
    ...claude(4, 20, 0.2),
    fast: [8, 40, 0.4, 10, 16],
  },
  'anthropic/claude-opus-5': { ...claude(5, 25), fast: [10, 50, 1, 12.5, 20] },
  'anthropic/claude-opus-4-8': {
    ...claude(5, 25),
    fast: [10, 50, 1, 12.5, 20],
  },
  'anthropic/claude-opus-4-7': claude(5, 25),
  'anthropic/claude-opus-4-6': claude(5, 25),
  'anthropic/claude-opus-4-5': claude(5, 25),
  'anthropic/claude-opus-4-1': claude(15, 75),
  'anthropic/claude-opus-4': claude(15, 75),
  'anthropic/claude-sonnet-5-5': claude(2, 10, 0.1),
  'anthropic/claude-sonnet-5': claude(2, 10, 0.2),
  'anthropic/claude-sonnet-4-6': claude(3, 15),
  'anthropic/claude-sonnet-4-5': claude(3, 15),
  'anthropic/claude-sonnet-4': claude(3, 15),
  'anthropic/claude-haiku-5-5': {
    ...claude(0.1, 0.5),
    threshold: 100_000,
    standardLong: [0.5, 2.5, 0.05, 0.625, 1],
  },
  'anthropic/claude-haiku-4-5': claude(1, 5),
  'anthropic/claude-3-5-haiku-20241022': claude(0.8, 4),
}

// providers report dated snapshots (gpt-5-nano-2025-08-07, claude-haiku-4-5-20251001);
// an exact entry wins so differently priced snapshots keep their own rates
const SNAPSHOT_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8})$/

function rateCard(model: string): RateCard | undefined
{
  const table = model.startsWith('anthropic/') ? ANTHROPIC_RATES : OPENAI_RATES
  return table[model] ?? table[model.replace(SNAPSHOT_SUFFIX, '')]
}

// unsupported model/tier combinations stay unpriced instead of guessing a family rate
export function estimateRequestCost(usage: BillingUsage): number | undefined
{
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteShortTokens,
    usage.cacheWriteLongTokens,
  ]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
    return undefined
  const anthropic = usage.model.startsWith('anthropic/')
  const card = rateCard(usage.model)
  if (!card) return undefined
  const tier =
    usage.serviceTier === 'default' || usage.serviceTier === 'standard'
      ? 'standard'
      : usage.serviceTier === 'priority' && !anthropic
        ? 'fast'
        : usage.serviceTier
  if (!['standard', 'batch', 'flex', 'fast', 'ultrafast'].includes(tier))
    return undefined
  const input =
    usage.inputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteShortTokens +
    usage.cacheWriteLongTokens
  const long = card.threshold !== undefined && input > card.threshold
  let rates = card[(tier + (long ? 'Long' : '')) as keyof RateCard] as
    Rates | undefined
  if (anthropic && tier === 'batch')
  {
    rates = (long ? card.standardLong : card.standard)?.map((rate) =>
      rate === null ? null : rate / 2
    ) as Rates
  }
  if (anthropic && tier === 'fast' && !card.threshold) rates = card.fast
  if (!rates) return undefined
  let cost = 0
  for (let index = 0; index < values.length; index++)
  {
    const rate = rates[index]
    if (values[index]! > 0 && (rate === null || rate === undefined))
      return undefined
    cost += (values[index]! * (rate ?? 0)) / 1_000_000
  }
  return cost
}
