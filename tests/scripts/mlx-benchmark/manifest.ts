// tests/scripts/mlx-benchmark/manifest.ts
// fixed acceptance cases and policy that result files cannot weaken

import { TASKS } from '../eval/tasks.js'
import type {
  BenchmarkPolicySnapshot,
  HardGateCategory,
  PrimaryMetric,
} from './types.js'

export const BENCHMARK_POLICY: Readonly<BenchmarkPolicySnapshot> =
  Object.freeze({
    warmups: 2,
    measuredRuns: 10,
    bootstrapIterations: 10_000,
    confidenceLevel: 0.95,
    requiredImprovement: 0.2,
    maximumRegression: 0.1,
    rssSampleIntervalMs: 100,
  })

export interface HardGateRequirement
{
  category: HardGateCategory
  caseId: string
  repetitions: number
  scope: 'all' | 'candidate'
}

const correctness: HardGateRequirement[] = TASKS.map((task) => ({
  category: 'correctness',
  caseId: task.id,
  repetitions: 5,
  scope: 'all',
}))

const toolSemantics: HardGateRequirement[] = [
  'single-call',
  'parallel-calls',
  'nested-escaped-arguments',
  'reasoning-with-call',
  'text-with-call',
  'prior-tool-result',
  'thinking-disabled',
].map((caseId) => ({
  category: 'tool-semantics',
  caseId,
  repetitions: 5,
  scope: 'all',
}))

const context: HardGateRequirement[] = [
  'short',
  '8k',
  '32k-or-ceiling',
  'repeated-prefix',
  'multi-round-agent',
].map((caseId) => ({
  category: 'context',
  caseId,
  repetitions: 5,
  scope: 'all',
}))

const lifecycle: HardGateRequirement[] = [
  {
    category: 'lifecycle',
    caseId: 'cancel-prefill',
    repetitions: 3,
    scope: 'all',
  },
  {
    category: 'lifecycle',
    caseId: 'cancel-decode',
    repetitions: 3,
    scope: 'all',
  },
  {
    category: 'lifecycle',
    caseId: 'next-request-after-cancel',
    repetitions: 3,
    scope: 'all',
  },
  {
    category: 'lifecycle',
    caseId: 'crash-restart-once',
    repetitions: 3,
    scope: 'candidate',
  },
  {
    category: 'lifecycle',
    caseId: 'timeout-recovery',
    repetitions: 3,
    scope: 'candidate',
  },
  {
    category: 'lifecycle',
    caseId: 'quit-no-descendants',
    repetitions: 3,
    scope: 'candidate',
  },
]

const residency: HardGateRequirement[] = [
  {
    category: 'residency',
    caseId: 'same-model-reuse',
    repetitions: 3,
    scope: 'all',
  },
  {
    category: 'residency',
    caseId: 'direct-mlx-ollama-direct-mlx',
    repetitions: 3,
    scope: 'candidate',
  },
]

export const HARD_GATE_REQUIREMENTS: readonly HardGateRequirement[] =
  Object.freeze([
    {
      category: 'artifact-availability',
      caseId: 'pinned-direct-artifact-installed',
      repetitions: 1,
      scope: 'candidate',
    },
    ...correctness,
    ...toolSemantics,
    ...context,
    ...lifecycle,
    ...residency,
  ])

export interface PerformanceWorkload
{
  id: string
  metrics: readonly PrimaryMetric[]
  resetModel: boolean
}

export const PERFORMANCE_WORKLOADS: readonly PerformanceWorkload[] =
  Object.freeze([
    {
      id: 'cold-start',
      metrics: ['coldFirstDeltaMs', 'agentWallMs', 'peakRssAboveBaselineBytes'],
      resetModel: true,
    },
    {
      id: 'short-code',
      metrics: [
        'warmTtftMs',
        'promptTokensPerSecond',
        'decodeTokensPerSecond',
        'agentWallMs',
        'peakRssAboveBaselineBytes',
      ],
      resetModel: false,
    },
    {
      id: 'long-context',
      metrics: [
        'warmTtftMs',
        'promptTokensPerSecond',
        'decodeTokensPerSecond',
        'agentWallMs',
        'peakRssAboveBaselineBytes',
      ],
      resetModel: false,
    },
    {
      id: 'repeated-prefix',
      metrics: [
        'warmTtftMs',
        'promptTokensPerSecond',
        'decodeTokensPerSecond',
        'agentWallMs',
        'peakRssAboveBaselineBytes',
      ],
      resetModel: false,
    },
  ])

export const PRIMARY_METRICS: readonly PrimaryMetric[] = Object.freeze([
  'coldFirstDeltaMs',
  'warmTtftMs',
  'promptTokensPerSecond',
  'decodeTokensPerSecond',
  'agentWallMs',
  'peakRssAboveBaselineBytes',
])

export function metricHigherIsBetter(metric: PrimaryMetric): boolean
{
  return (
    metric === 'promptTokensPerSecond' || metric === 'decodeTokensPerSecond'
  )
}
