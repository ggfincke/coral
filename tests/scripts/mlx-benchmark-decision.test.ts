// tests/scripts/mlx-benchmark-decision.test.ts
// verify fail-closed benchmark decision policy with deterministic evidence

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { decideBenchmark } from './mlx-benchmark/decision.js'
import {
  BENCHMARK_POLICY,
  HARD_GATE_REQUIREMENTS,
  PERFORMANCE_WORKLOADS,
  metricHigherIsBetter,
} from './mlx-benchmark/manifest.js'
import { stockChunk } from './mlx-benchmark/providers.js'
import type {
  BenchmarkResult,
  HardGateObservation,
  MetricVector,
  PrimaryMetric,
  ToolEvidence,
  TopologyIdentity,
} from './mlx-benchmark/types.js'

const BASELINE_ID = 'ollama-qwen'
const STOCK_ID = 'stock-mlx-qwen'
const FORENSIC_ID = 'pr64-forensic'
const MODEL_PAIR_ID = 'qwen38-27b-nvfp4'

// provide clean, case-specific evidence for every tool-sensitive hard gate
function toolEvidence(caseId: string): ToolEvidence
{
  const evidence: ToolEvidence = {
    expectedCalls: 1,
    actualCalls: 1,
    toolErrors: 0,
    repairedToolCalls: 0,
    nameRepairs: 0,
    stallNudges: 0,
    validationFailures: 0,
    editRepairs: 0,
    reprompts: 0,
    maxCallsInResponse: 1,
    thinkingChars: 8,
  }

  switch (caseId)
  {
    case 'parallel-calls':
      return {
        ...evidence,
        expectedCalls: 2,
        actualCalls: 2,
        maxCallsInResponse: 2,
      }
    case 'nested-escaped-arguments':
      return { ...evidence, argumentsMatched: true }
    case 'reasoning-with-call':
      return { ...evidence, reasoningWithToolCall: true }
    case 'text-with-call':
      return { ...evidence, textBeforeToolCall: true }
    case 'prior-tool-result':
      return { ...evidence, priorToolResultUsed: true }
    case 'thinking-disabled':
      return { ...evidence, thinkingChars: 0 }
    default:
      return evidence
  }
}

function residencyMemory(
  topology: TopologyIdentity,
  caseId: string
): HardGateObservation['memorySnapshots']
{
  const stages =
    caseId === 'same-model-reuse'
      ? ['after-first-request', 'after-second-request']
      : [
          'after-direct-first',
          'after-direct-unload',
          'after-ollama',
          'after-ollama-unload',
          'after-direct-second',
        ]
  return stages.map((stage) =>
  {
    const direct =
      topology.role === 'candidate' &&
      (caseId === 'same-model-reuse' ||
        stage === 'after-direct-first' ||
        stage === 'after-direct-second')
    return {
      stage,
      processTreeRssBytes:
        stage === 'after-direct-unload' || stage === 'after-ollama-unload'
          ? 100
          : 200,
      ...(direct
        ? {
            mlxAllocatorActiveBytes: 10,
            mlxAllocatorCacheBytes: 20,
            mlxAllocatorPeakBytes: 30,
            mlxModelIdentity: '/models/mlx',
          }
        : {}),
    }
  })
}

// expand the fixed manifest into one observation per required repetition
function hardGates(topologies: TopologyIdentity[]): HardGateObservation[]
{
  const observations: HardGateObservation[] = []
  for (const topology of topologies)
  {
    if (topology.role === 'forensic') continue
    for (const requirement of HARD_GATE_REQUIREMENTS)
    {
      if (requirement.scope === 'candidate' && topology.role === 'baseline')
      {
        continue
      }
      for (
        let repetition = 1;
        repetition <= requirement.repetitions;
        repetition++
      )
      {
        const usesTools =
          requirement.category === 'correctness' ||
          requirement.category === 'tool-semantics'
        observations.push({
          topologyId: topology.id,
          modelPairId: MODEL_PAIR_ID,
          category: requirement.category,
          caseId: requirement.caseId,
          repetition,
          passed: true,
          detail: 'passed synthetic acceptance evidence',
          sequence: observations.length + 1,
          ...(requirement.category === 'context'
            ? {
                promptTokens:
                  requirement.caseId === '32k-or-ceiling' ? 24_064 : 8_000,
              }
            : {}),
          ...(usesTools
            ? { toolEvidence: toolEvidence(requirement.caseId) }
            : {}),
          ...(requirement.category === 'residency'
            ? { memorySnapshots: residencyMemory(topology, requirement.caseId) }
            : {}),
        })
      }
    }
  }
  return observations
}

// give lower-is-better metrics 25% less and throughput metrics 25% more
function metrics(
  names: readonly PrimaryMetric[],
  candidate: boolean
): MetricVector
{
  const values: MetricVector = {}
  for (const name of names)
  {
    const higherIsBetter = metricHigherIsBetter(name)
    values[name] = candidate ? (higherIsBetter ? 125 : 75) : 100
  }
  if (candidate)
  {
    values.mlxAllocatorActiveBytes = 10
    values.mlxAllocatorCacheBytes = 20
    values.mlxAllocatorPeakBytes = 30
  }
  return values
}

// build a complete, policy-strength result from the checked-in manifest
function completeResult(): BenchmarkResult
{
  const topologies: TopologyIdentity[] = [
    {
      id: BASELINE_ID,
      kind: 'ollama',
      role: 'baseline',
      description: 'Ollama baseline',
      immutableRevision: 'sha256:ollama',
    },
    {
      id: STOCK_ID,
      kind: 'stock-mlx',
      role: 'candidate',
      description: 'stock mlx_lm.server candidate',
      immutableRevision: 'mlx-lm@0.31.3+mlx@0.32.0',
    },
    {
      id: FORENSIC_ID,
      kind: 'custom-mlx',
      role: 'forensic',
      description: 'immutable PR #64 forensic evidence',
      immutableRevision: '39a33a45682007333b7db36fd71a4ef171fd81e0',
    },
  ]

  const candidates = topologies.filter(
    (topology) => topology.role === 'candidate'
  )
  return {
    schemaVersion: 1,
    runId: 'synthetic-decision-policy',
    status: 'complete',
    provenance: {
      generatedAt: '2026-08-16T12:00:00.000Z',
      machine: {
        chip: 'Apple M4 Max',
        unifiedMemoryBytes: 137_438_953_472,
        os: 'macOS 27.0',
        powerMode: 'AC power',
      },
      software: {
        coralRevision: 'a60b2ef6fc931a179b94a546304bb2fb9e7e7961',
        node: '26.7.0',
        ollama: '0.32.13',
        mlx: '0.32.0',
        mlxLm: '0.31.3',
        python: '3.14.7',
        uv: '0.12.3',
      },
      command: ['tsx', 'tests/scripts/mlx-benchmark/run.ts'],
      environment: {},
      notes: ['deterministic synthetic decision evidence'],
    },
    policy: { ...BENCHMARK_POLICY },
    configuration: {
      contextCeiling: 32_768,
      maxOutputTokens: 8_192,
      requestTimeoutMs: 600_000,
      temperature: 0,
      topP: 1,
      topologies: [
        {
          id: BASELINE_ID,
          kind: 'ollama',
          role: 'baseline',
          description: 'Ollama baseline',
          host: 'http://127.0.0.1:11434',
          listenerPort: 11434,
          processRootPids: [],
        },
        {
          id: STOCK_ID,
          kind: 'stock-mlx',
          role: 'candidate',
          description: 'stock mlx_lm.server candidate',
          launch: {
            command: '/opt/homebrew/bin/uv',
            args: [
              'run',
              '--frozen',
              '--no-sync',
              '--offline',
              'python',
              '/repo/tests/scripts/mlx-benchmark/server_with_metrics.py',
            ],
            cwd: '/repo',
            env: {
              UV_PYTHON_DOWNLOADS: 'never',
              HF_HUB_OFFLINE: '1',
              TRANSFORMERS_OFFLINE: '1',
            },
          },
          host: '127.0.0.1',
          bindAttempts: 8,
          deniedBrowserOrigin: 'https://benchmark.invalid',
          startupTimeoutMs: 15_000,
        },
        {
          id: FORENSIC_ID,
          kind: 'custom-mlx',
          role: 'forensic',
          description: 'immutable PR #64 forensic evidence',
          checkout: '/repo-pr64',
          expectedRevision: '39a33a45682007333b7db36fd71a4ef171fd81e0',
          environment: {},
        },
      ],
    },
    topologies,
    forensicFindings: [
      {
        topologyId: FORENSIC_ID,
        immutableRevision: '39a33a45682007333b7db36fd71a4ef171fd81e0',
        disposition: 'disqualified',
        findings: ['synthetic forensic disqualification'],
      },
    ],
    modelPairs: [
      {
        id: MODEL_PAIR_ID,
        description: 'Qwen3.8 27B shippable configurations',
        localEvidence: ['synthetic local artifact evidence'],
        ollama: {
          model: 'qwen3.8:27b-mlx',
          revision: 'sha256:ollama',
          tokenizerRevision: 'sha256:tokenizer',
          chatTemplateSha256: 'sha256:template',
          quantization: 'NVFP4',
          contextWindow: 262_144,
          localPath: '/models/ollama',
        },
        mlx: {
          model: 'mlx-community/Qwen3.8-27B-nvfp4',
          revision: '5ff8ef173ad0d7c3aae92f0be43031a6ab8067c6',
          tokenizerRevision: '5ff8ef173ad0d7c3aae92f0be43031a6ab8067c6',
          chatTemplateSha256: 'sha256:template',
          quantization: 'NVFP4',
          contextWindow: 262_144,
          localPath: '/models/mlx',
        },
      },
    ],
    baselineSmokes: [
      {
        topologyId: BASELINE_ID,
        modelPairId: MODEL_PAIR_ID,
        passed: true,
        detail: 'returned exact OK',
        temperature: 0,
        think: false,
        contextWindow: 4096,
        promptTokens: 17,
        completionTokens: 1,
        loadMs: 3656.58,
        totalMs: 4021.15,
        finishReason: 'stop',
        artifactRevision: 'sha256:ollama',
      },
    ],
    hardGates: hardGates(topologies),
    performanceCells: candidates.flatMap((topology) =>
      PERFORMANCE_WORKLOADS.map((workload) => ({
        candidateTopologyId: topology.id,
        modelPairId: MODEL_PAIR_ID,
        workloadId: workload.id,
        warmupsCompleted: BENCHMARK_POLICY.warmups,
        metrics: [...workload.metrics],
        samples: Array.from(
          { length: BENCHMARK_POLICY.measuredRuns },
          (_, index) => ({
            pairIndex: index + 1,
            order: index % 2 === 0 ? 'baseline-first' : 'candidate-first',
            baseline: metrics(workload.metrics, false),
            candidate: metrics(workload.metrics, true),
          })
        ),
      }))
    ),
  }
}

describe('MLX benchmark decision policy', () =>
{
  it('adapts the pinned MLX-LM complete tool-call frame without repair', () =>
  {
    const chunk = stockChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                type: 'function',
                function: {
                  name: 'benchmark_probe',
                  arguments: '{"label":"wire","payload":{"value":7}}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })

    assert.deepEqual(chunk?.message.tool_calls, [
      {
        type: 'function',
        function: {
          index: 0,
          name: 'benchmark_probe',
          arguments: { label: 'wire', payload: { value: 7 } },
        },
      },
    ])
  })

  it('records an artifact preflight failure as a no-go without performance evidence', () =>
  {
    const result = completeResult()
    const artifact = result.hardGates.find(
      (row) => row.category === 'artifact-availability'
    )
    assert.ok(artifact)
    artifact.passed = false
    artifact.detail = 'pinned direct weights and tokenizer are absent'
    result.hardGates = [artifact]
    result.performanceCells = []

    const decision = decideBenchmark(result)

    assert.equal(decision.verdict, 'no-go')
    assert.equal(decision.selectedTopologyId, undefined)
    assert.equal(decision.candidates[0]?.hardGatesPassed, false)
    assert.equal(decision.candidates[0]?.performancePassed, false)
    assert.match(
      decision.candidates[0]?.failures.join('\n') ?? '',
      /pinned direct artifact failed/
    )
    assert.match(decision.failures.join('\n'), /preflight blocked/)
  })

  it('qualifies >=20% paired improvements and selects stock', () =>
  {
    const decision = decideBenchmark(completeResult())

    assert.equal(decision.verdict, 'go')
    assert.equal(decision.selectedTopologyId, STOCK_ID)
    assert.equal(decision.candidates.length, 1)
    for (const candidate of decision.candidates)
    {
      assert.equal(candidate.hardGatesPassed, true)
      assert.equal(candidate.performancePassed, true)
      assert.equal(candidate.materialImprovement, true)
      assert.equal(candidate.qualified, true)
      assert.ok(
        candidate.metrics.some(
          (metric) =>
            metric.aggregate.lower >= BENCHMARK_POLICY.requiredImprovement
        )
      )
    }
  })

  it('rejects a failed gate, per-cell regression, and malformed gate structure', () =>
  {
    const regression = completeResult()
    const regressedCell = regression.performanceCells.find(
      (cell) =>
        cell.candidateTopologyId === STOCK_ID &&
        cell.workloadId === 'short-code'
    )
    assert.ok(regressedCell)
    for (const sample of regressedCell.samples)
    {
      sample.candidate.warmTtftMs = 115
    }

    const regressionDecision = decideBenchmark(regression)
    assert.equal(regressionDecision.verdict, 'no-go')
    assert.equal(regressionDecision.candidates[0]?.performancePassed, false)
    assert.match(
      regressionDecision.candidates[0]?.failures.join('\n') ?? '',
      /short-code\/warmTtftMs permits more than 10% regression/
    )

    const malformed = completeResult()
    const failedGate = malformed.hardGates.find(
      (row) => row.topologyId === STOCK_ID && row.category === 'correctness'
    )
    assert.ok(failedGate)
    failedGate.passed = false
    failedGate.detail = 'deterministic coding task failed'
    const residencyGate = malformed.hardGates.find(
      (row) =>
        row.topologyId === STOCK_ID &&
        row.caseId === 'direct-mlx-ollama-direct-mlx'
    )
    assert.ok(residencyGate)
    const afterOllamaUnload = residencyGate.memorySnapshots?.find(
      (snapshot) => snapshot.stage === 'after-ollama-unload'
    )
    assert.ok(afterOllamaUnload)
    afterOllamaUnload.processTreeRssBytes = 200
    malformed.baselineSmokes[0]!.artifactRevision = 'drifted-revision'
    const expectedCell = malformed.performanceCells[0]
    assert.ok(expectedCell)
    malformed.performanceCells.push(
      { ...structuredClone(expectedCell), workloadId: 'unexpected-workload' },
      structuredClone(expectedCell),
      {
        ...structuredClone(expectedCell),
        candidateTopologyId: 'unknown-candidate',
      }
    )
    const first = malformed.hardGates[0]
    assert.ok(first)
    malformed.hardGates.push({
      ...first,
      category: 'context',
      caseId: 'unregistered-context-case',
      sequence: first.sequence,
    })
    const malformedDecision = decideBenchmark(malformed)
    assert.equal(malformedDecision.verdict, 'no-go')
    assert.equal(malformedDecision.candidates[0]?.hardGatesPassed, false)
    assert.equal(malformedDecision.candidates[0]?.performancePassed, false)
    assert.match(
      malformedDecision.candidates[0]?.failures.join('\n') ?? '',
      /hard gate failed/
    )
    assert.match(
      malformedDecision.candidates[0]?.failures.join('\n') ?? '',
      /hard gate lacked residency memory evidence/
    )
    assert.match(
      malformedDecision.failures.join('\n'),
      /sequence values must be unique and consecutive/
    )
    assert.match(
      malformedDecision.failures.join('\n'),
      /unexpected hard-gate observation/
    )
    assert.match(
      malformedDecision.failures.join('\n'),
      /smoke artifact revision/
    )
    assert.match(
      malformedDecision.failures.join('\n'),
      /unknown candidate topology/
    )
    assert.match(
      malformedDecision.candidates[0]?.failures.join('\n') ?? '',
      /unexpected performance cell/
    )
    assert.match(
      malformedDecision.candidates[0]?.failures.join('\n') ?? '',
      /duplicate performance cell/
    )

    const duplicate = completeResult()
    const duplicatedGate = duplicate.hardGates.find(
      (row) => row.topologyId === STOCK_ID && row.category === 'correctness'
    )
    assert.ok(duplicatedGate)
    duplicate.hardGates.push({
      ...duplicatedGate,
      sequence: duplicate.hardGates.length + 1,
    })
    const duplicateDecision = decideBenchmark(duplicate)
    assert.equal(duplicateDecision.verdict, 'no-go')
    assert.equal(duplicateDecision.candidates[0]?.hardGatesPassed, false)
    assert.match(
      duplicateDecision.candidates[0]?.failures.join('\n') ?? '',
      /duplicate hard-gate observation/
    )
  })
})
