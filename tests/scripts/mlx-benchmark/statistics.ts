// tests/scripts/mlx-benchmark/statistics.ts
// deterministic paired-bootstrap confidence intervals for primary metrics

import type { ConfidenceInterval } from './types.js'

interface PairedValue
{
  baseline: number
  candidate: number
}

// xorshift32 keeps decisions reproducible without a statistics dependency
function seededRandom(seed: number): () => number
{
  let state = seed >>> 0
  if (state === 0) state = 0x9e3779b9
  return () =>
  {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function mean(values: number[]): number
{
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function improvement(pair: PairedValue, higherIsBetter: boolean): number
{
  if (pair.baseline <= 0 || !Number.isFinite(pair.baseline))
  {
    throw new Error('baseline metrics must be finite and greater than zero')
  }
  if (pair.candidate <= 0 || !Number.isFinite(pair.candidate))
  {
    throw new Error('candidate metrics must be finite and greater than zero')
  }
  return higherIsBetter
    ? (pair.candidate - pair.baseline) / pair.baseline
    : (pair.baseline - pair.candidate) / pair.baseline
}

function quantile(sorted: number[], probability: number): number
{
  if (sorted.length === 0) throw new Error('cannot sample an empty metric set')
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const left = sorted[lower]!
  const right = sorted[upper]!
  return left + (right - left) * (position - lower)
}

export function pairedBootstrap(
  pairs: PairedValue[],
  options: {
    higherIsBetter: boolean
    iterations: number
    confidenceLevel: number
    seed: number
  }
): ConfidenceInterval
{
  if (pairs.length < 2)
  {
    throw new Error('paired bootstrap requires at least two samples')
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1_000)
  {
    throw new Error('paired bootstrap requires at least 1000 iterations')
  }
  if (options.confidenceLevel <= 0 || options.confidenceLevel >= 1)
  {
    throw new Error('confidence level must be between zero and one')
  }

  const observed = pairs.map((pair) =>
    improvement(pair, options.higherIsBetter)
  )
  const random = seededRandom(options.seed)
  const samples = new Array<number>(options.iterations)

  for (let iteration = 0; iteration < options.iterations; iteration++)
  {
    let total = 0
    for (let index = 0; index < observed.length; index++)
    {
      total += observed[Math.floor(random() * observed.length)]!
    }
    samples[iteration] = total / observed.length
  }

  samples.sort((left, right) => left - right)
  const alpha = (1 - options.confidenceLevel) / 2
  return {
    estimate: mean(observed),
    lower: quantile(samples, alpha),
    upper: quantile(samples, 1 - alpha),
  }
}
