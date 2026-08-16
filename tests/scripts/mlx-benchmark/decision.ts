// tests/scripts/mlx-benchmark/decision.ts
// fail-closed benchmark validation and go/no-go selection

import {
  BENCHMARK_POLICY,
  HARD_GATE_REQUIREMENTS,
  PERFORMANCE_WORKLOADS,
  PRIMARY_METRICS,
  metricHigherIsBetter,
} from './manifest.js'
import { configurationPolicyFailures } from './config.js'
import { pairedBootstrap } from './statistics.js'
import type {
  BenchmarkDecision,
  BenchmarkResult,
  CandidateDecision,
  HardGateObservation,
  MetricDecision,
  PairedMetricSample,
  PerformanceCell,
  PrimaryMetric,
  ToolEvidence,
  TopologyIdentity,
} from './types.js'

const OLLAMA_REVISION_PATTERN = /^(?:sha256:)?([0-9a-f]{64})$/i

function normalizedOllamaRevision(value: string): string | undefined
{
  return OLLAMA_REVISION_PATTERN.exec(value)?.[1]?.toLowerCase()
}

function stableHash(text: string): number
{
  let hash = 2166136261
  for (let index = 0; index < text.length; index++)
  {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function samePolicy(result: BenchmarkResult): boolean
{
  return (
    result.policy.warmups === BENCHMARK_POLICY.warmups &&
    result.policy.measuredRuns === BENCHMARK_POLICY.measuredRuns &&
    result.policy.bootstrapIterations ===
      BENCHMARK_POLICY.bootstrapIterations &&
    result.policy.confidenceLevel === BENCHMARK_POLICY.confidenceLevel &&
    result.policy.requiredImprovement ===
      BENCHMARK_POLICY.requiredImprovement &&
    result.policy.maximumRegression === BENCHMARK_POLICY.maximumRegression &&
    result.policy.rssSampleIntervalMs === BENCHMARK_POLICY.rssSampleIntervalMs
  )
}

function topologyByRole(
  result: BenchmarkResult,
  role: TopologyIdentity['role']
): TopologyIdentity[]
{
  return result.topologies.filter((topology) => topology.role === role)
}

function topologyConfigurationFailures(result: BenchmarkResult): string[]
{
  const failures = configurationPolicyFailures(result.configuration)
  const configured = new Map(
    result.configuration.topologies.map((topology) => [topology.id, topology])
  )
  if (configured.size !== result.topologies.length)
  {
    failures.push('runtime configuration and topology evidence counts differ')
  }
  for (const topology of result.topologies)
  {
    const source = configured.get(topology.id)
    if (!source)
    {
      failures.push(`topology evidence lacks configuration: ${topology.id}`)
      continue
    }
    if (source.kind !== topology.kind || source.role !== topology.role)
    {
      failures.push(`topology configuration identity drifted: ${topology.id}`)
    }
    if (
      source.kind === 'custom-mlx' &&
      topology.immutableRevision !== source.expectedRevision
    )
    {
      failures.push(`forensic topology revision drifted: ${topology.id}`)
    }
    if (
      source.kind === 'stock-mlx' &&
      topology.immutableRevision !==
        `mlx-lm@${result.provenance.software.mlxLm}+mlx@${result.provenance.software.mlx}`
    )
    {
      failures.push(`stock topology software identity drifted: ${topology.id}`)
    }
  }
  for (const source of result.configuration.topologies)
  {
    if (!result.topologies.some((topology) => topology.id === source.id))
    {
      failures.push(`configured topology lacks evidence: ${source.id}`)
    }
  }
  return failures
}

function gateKey(
  topologyId: string,
  modelPairId: string,
  category: string,
  caseId: string,
  repetition: number
): string
{
  return [topologyId, modelPairId, category, caseId, repetition].join('\0')
}

function reliabilityClean(evidence: ToolEvidence): boolean
{
  return (
    evidence.toolErrors === 0 &&
    evidence.repairedToolCalls === 0 &&
    evidence.nameRepairs === 0 &&
    evidence.stallNudges === 0 &&
    evidence.validationFailures === 0 &&
    evidence.editRepairs === 0 &&
    evidence.reprompts === 0
  )
}

function toolEvidencePassed(observation: HardGateObservation): boolean
{
  const evidence = observation.toolEvidence
  if (!evidence || !reliabilityClean(evidence)) return false
  if (evidence.expectedCalls !== undefined)
  {
    if (evidence.actualCalls !== evidence.expectedCalls) return false
  }
  else if (evidence.actualCalls < 1)
  {
    return false
  }

  switch (observation.caseId)
  {
    case 'parallel-calls':
      return evidence.maxCallsInResponse >= 2
    case 'nested-escaped-arguments':
      return evidence.argumentsMatched === true
    case 'reasoning-with-call':
      return evidence.reasoningWithToolCall === true
    case 'text-with-call':
      return evidence.textBeforeToolCall === true
    case 'prior-tool-result':
      return evidence.priorToolResultUsed === true
    case 'thinking-disabled':
      return evidence.thinkingChars === 0
    default:
      return true
  }
}

function residencyEvidencePassed(
  observation: HardGateObservation,
  topology: TopologyIdentity,
  expectedModelIdentity: string,
  expectedOllamaIdentity: string,
  expectedOllamaRevision: string
): boolean
{
  const snapshots = observation.memorySnapshots ?? []
  const expected =
    observation.caseId === 'same-model-reuse'
      ? ['after-first-request', 'after-second-request']
      : observation.caseId === 'direct-mlx-ollama-direct-mlx'
        ? [
            'after-direct-first',
            'after-direct-unload',
            'after-ollama',
            'after-ollama-unload',
            'after-direct-second',
          ]
        : []
  if (
    snapshots.length !== expected.length ||
    snapshots.some(
      (snapshot, index) =>
        snapshot.stage !== expected[index] || snapshot.processTreeRssBytes < 0
    )
  )
  {
    return false
  }
  if (topology.role !== 'candidate') return true
  if (observation.caseId === 'direct-mlx-ollama-direct-mlx')
  {
    const byStage = new Map(
      snapshots.map((snapshot) => [snapshot.stage, snapshot])
    )
    const afterOllamaUnload = byStage.get('after-ollama-unload')!
    const expectedDigest = normalizedOllamaRevision(expectedOllamaRevision)
    if (!expectedDigest) return false
    const exactModelRemained = afterOllamaUnload.ollamaRunningModels?.some(
      (model) =>
        model.name === expectedOllamaIdentity ||
        model.model === expectedOllamaIdentity ||
        model.digest.replace(/^sha256:/i, '').toLowerCase() === expectedDigest
    )
    if (
      byStage.get('after-direct-unload')!.processTreeRssBytes >=
        byStage.get('after-direct-first')!.processTreeRssBytes ||
      afterOllamaUnload.processTreeRssBytes <= 0 ||
      afterOllamaUnload.ollamaRunningModels === undefined ||
      exactModelRemained !== false
    )
    {
      return false
    }
  }
  const directStages =
    observation.caseId === 'same-model-reuse'
      ? new Set(expected)
      : new Set(['after-direct-first', 'after-direct-second'])
  return snapshots
    .filter((snapshot) => directStages.has(snapshot.stage))
    .every(
      (snapshot) =>
        snapshot.mlxAllocatorActiveBytes !== undefined &&
        snapshot.mlxAllocatorActiveBytes > 0 &&
        snapshot.mlxAllocatorCacheBytes !== undefined &&
        snapshot.mlxAllocatorPeakBytes !== undefined &&
        snapshot.mlxAllocatorPeakBytes >= snapshot.mlxAllocatorActiveBytes &&
        snapshot.mlxModelIdentity === expectedModelIdentity
    )
}

function contextEvidencePassed(
  result: BenchmarkResult,
  observation: HardGateObservation
): boolean
{
  const promptTokens = observation.promptTokens ?? 0
  const reserve = Math.min(
    result.configuration.maxOutputTokens,
    Math.max(512, Math.floor(result.configuration.contextCeiling / 4))
  )
  const longTarget = Math.max(
    1,
    Math.min(32_000, result.configuration.contextCeiling - reserve - 512)
  )
  const minimum =
    observation.caseId === '8k' || observation.caseId === 'repeated-prefix'
      ? Math.min(8_000, longTarget)
      : observation.caseId === '32k-or-ceiling'
        ? longTarget
        : 1
  return (
    promptTokens >= minimum &&
    promptTokens <= result.configuration.contextCeiling
  )
}

function hardGateFailures(
  result: BenchmarkResult,
  topology: TopologyIdentity
): string[]
{
  const failures: string[] = []
  const rows = new Map<string, HardGateObservation>()
  for (const observation of result.hardGates)
  {
    const key = gateKey(
      observation.topologyId,
      observation.modelPairId,
      observation.category,
      observation.caseId,
      observation.repetition
    )
    if (rows.has(key)) failures.push(`duplicate hard-gate observation: ${key}`)
    rows.set(key, observation)
  }

  for (const modelPair of result.modelPairs)
  {
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
        const key = gateKey(
          topology.id,
          modelPair.id,
          requirement.category,
          requirement.caseId,
          repetition
        )
        const observation = rows.get(key)
        if (!observation)
        {
          failures.push(`missing hard-gate observation: ${key}`)
          continue
        }
        if (!observation.passed)
        {
          failures.push(`hard gate failed: ${key}: ${observation.detail}`)
          continue
        }
        if (
          (requirement.category === 'correctness' ||
            requirement.category === 'tool-semantics') &&
          !toolEvidencePassed(observation)
        )
        {
          failures.push(`hard gate lacked clean tool evidence: ${key}`)
        }
        if (
          requirement.category === 'context' &&
          !contextEvidencePassed(result, observation)
        )
        {
          failures.push(
            `hard gate lacked actual context-token evidence: ${key}`
          )
        }
        if (
          requirement.category === 'residency' &&
          !residencyEvidencePassed(
            observation,
            topology,
            modelPair.mlx.localPath,
            modelPair.ollama.model,
            modelPair.ollama.revision
          )
        )
        {
          failures.push(`hard gate lacked residency memory evidence: ${key}`)
        }
      }
    }
  }

  return failures
}

function observationStructureFailures(result: BenchmarkResult): string[]
{
  const failures: string[] = []
  for (const pair of result.modelPairs)
  {
    const expectedRevision = normalizedOllamaRevision(pair.ollama.revision)
    if (!expectedRevision)
    {
      failures.push(
        `${pair.id} Ollama revision must be optional sha256: plus exactly 64 hexadecimal characters`
      )
    }
    const smokes = result.baselineSmokes.filter(
      (smoke) =>
        smoke.modelPairId === pair.id &&
        result.topologies.some(
          (topology) =>
            topology.id === smoke.topologyId && topology.role === 'baseline'
        )
    )
    if (smokes.length !== 1)
    {
      failures.push(`${pair.id} requires exactly one Ollama baseline smoke`)
    }
    else
    {
      if (!smokes[0]!.passed)
      {
        failures.push(`${pair.id} requires a passing Ollama baseline smoke`)
      }
      const smokeRevision = normalizedOllamaRevision(
        smokes[0]!.artifactRevision
      )
      if (!expectedRevision || smokeRevision !== expectedRevision)
      {
        failures.push(
          `${pair.id} smoke artifact revision ${smokes[0]!.artifactRevision} ` +
            `did not match ${pair.ollama.revision}`
        )
      }
    }
  }
  const topologyIds = new Set(result.topologies.map((topology) => topology.id))
  const pairIds = new Set(result.modelPairs.map((pair) => pair.id))
  const allowed = new Set<string>()
  for (const topology of result.topologies)
  {
    const requirements =
      topology.role === 'forensic'
        ? HARD_GATE_REQUIREMENTS.filter(
            (item) => item.category === 'artifact-availability'
          )
        : HARD_GATE_REQUIREMENTS.filter(
            (item) => item.scope === 'all' || topology.role === 'candidate'
          )
    for (const pair of result.modelPairs)
    {
      for (const requirement of requirements)
      {
        for (
          let repetition = 1;
          repetition <= requirement.repetitions;
          repetition++
        )
        {
          allowed.add(
            gateKey(
              topology.id,
              pair.id,
              requirement.category,
              requirement.caseId,
              repetition
            )
          )
        }
      }
    }
  }

  const sequences = [...result.hardGates]
    .map((row) => row.sequence)
    .sort((left, right) => left - right)
  for (let index = 0; index < sequences.length; index++)
  {
    if (sequences[index] !== index + 1)
    {
      failures.push('hard-gate sequence values must be unique and consecutive')
      break
    }
  }
  for (const row of result.hardGates)
  {
    if (!topologyIds.has(row.topologyId))
    {
      failures.push(`hard-gate row used unknown topology ${row.topologyId}`)
      continue
    }
    if (!pairIds.has(row.modelPairId))
    {
      failures.push(`hard-gate row used unknown model pair ${row.modelPairId}`)
      continue
    }
    const key = gateKey(
      row.topologyId,
      row.modelPairId,
      row.category,
      row.caseId,
      row.repetition
    )
    if (!allowed.has(key))
      failures.push(`unexpected hard-gate observation: ${key}`)
  }
  const candidateIds = new Set(
    result.topologies
      .filter((topology) => topology.role === 'candidate')
      .map((topology) => topology.id)
  )
  for (const cell of result.performanceCells)
  {
    if (!candidateIds.has(cell.candidateTopologyId))
    {
      failures.push(
        `performance cell used unknown candidate topology ${cell.candidateTopologyId}`
      )
    }
  }
  return failures
}

function artifactPreflightFailures(
  result: BenchmarkResult,
  topology: TopologyIdentity
): string[]
{
  const failures: string[] = []
  for (const pair of result.modelPairs)
  {
    const rows = result.hardGates.filter(
      (row) =>
        row.topologyId === topology.id &&
        row.modelPairId === pair.id &&
        row.category === 'artifact-availability' &&
        row.caseId === 'pinned-direct-artifact-installed'
    )
    if (rows.length !== 1)
    {
      failures.push(
        `${topology.id}/${pair.id} requires one pinned-direct-artifact preflight`
      )
    }
    else if (!rows[0]!.passed)
    {
      failures.push(
        `${topology.id}/${pair.id} pinned direct artifact failed: ${rows[0]!.detail}`
      )
    }
  }
  return failures
}

function metricPairs(
  cell: PerformanceCell,
  metric: PrimaryMetric
): Array<{ baseline: number; candidate: number }>
{
  return cell.samples.map((sample) =>
  {
    const baseline = sample.baseline[metric]
    const candidate = sample.candidate[metric]
    if (baseline === undefined || candidate === undefined)
    {
      throw new Error(
        `performance cell ${cell.modelPairId}/${cell.workloadId} omitted ${metric}`
      )
    }
    return { baseline, candidate }
  })
}

function validateSampleOrder(
  samples: PairedMetricSample[],
  measuredRuns: number
): string | undefined
{
  if (samples.length !== measuredRuns)
  {
    return `expected ${measuredRuns} measured pairs, got ${samples.length}`
  }
  for (let index = 0; index < samples.length; index++)
  {
    const sample = samples[index]!
    if (sample.pairIndex !== index + 1)
    {
      return `pair index ${sample.pairIndex} was not consecutive at ${index + 1}`
    }
    const expected = index % 2 === 0 ? 'baseline-first' : 'candidate-first'
    if (sample.order !== expected)
    {
      return `pair ${sample.pairIndex} order was ${sample.order}, expected ${expected}`
    }
  }
  return undefined
}

function performanceDecision(
  result: BenchmarkResult,
  topology: TopologyIdentity
): { metrics: MetricDecision[]; failures: string[] }
{
  const failures: string[] = []
  const cells = result.performanceCells.filter(
    (cell) => cell.candidateTopologyId === topology.id
  )
  const allowedKeys = new Set(
    result.modelPairs.flatMap((pair) =>
      PERFORMANCE_WORKLOADS.map((workload) => `${pair.id}\0${workload.id}`)
    )
  )
  const expectedCells = new Map<string, PerformanceCell>()
  for (const cell of cells)
  {
    const key = `${cell.modelPairId}\0${cell.workloadId}`
    if (!allowedKeys.has(key))
    {
      failures.push(`unexpected performance cell: ${key}`)
      continue
    }
    if (expectedCells.has(key))
      failures.push(`duplicate performance cell: ${key}`)
    expectedCells.set(key, cell)
  }
  const acceptedCells = cells.filter((cell) =>
    allowedKeys.has(`${cell.modelPairId}\0${cell.workloadId}`)
  )

  for (const modelPair of result.modelPairs)
  {
    for (const workload of PERFORMANCE_WORKLOADS)
    {
      const key = `${modelPair.id}\0${workload.id}`
      const cell = expectedCells.get(key)
      if (!cell)
      {
        failures.push(`missing performance cell: ${key}`)
        continue
      }
      if (cell.warmupsCompleted !== BENCHMARK_POLICY.warmups)
      {
        failures.push(
          `${key} completed ${cell.warmupsCompleted} warmups, expected ${BENCHMARK_POLICY.warmups}`
        )
      }
      const orderFailure = validateSampleOrder(
        cell.samples,
        BENCHMARK_POLICY.measuredRuns
      )
      if (orderFailure) failures.push(`${key}: ${orderFailure}`)
      for (const sample of cell.samples)
      {
        if (
          sample.candidate.mlxAllocatorActiveBytes === undefined ||
          sample.candidate.mlxAllocatorCacheBytes === undefined ||
          sample.candidate.mlxAllocatorPeakBytes === undefined
        )
        {
          failures.push(
            `${key} pair ${sample.pairIndex} omitted separate MLX allocator metrics`
          )
        }
      }
      const expectedMetrics = [...workload.metrics].sort().join(',')
      const actualMetrics = [...cell.metrics].sort().join(',')
      if (actualMetrics !== expectedMetrics)
      {
        failures.push(
          `${key} metrics were ${actualMetrics}, expected ${expectedMetrics}`
        )
      }
    }
  }

  const decisions: MetricDecision[] = []
  for (const metric of PRIMARY_METRICS)
  {
    const metricCells = acceptedCells.filter((cell) =>
      cell.metrics.includes(metric)
    )
    const allPairs: Array<{ baseline: number; candidate: number }> = []
    const cellDecisions: MetricDecision['cells'] = []
    for (const cell of metricCells)
    {
      try
      {
        const pairs = metricPairs(cell, metric)
        allPairs.push(...pairs)
        const interval = pairedBootstrap(pairs, {
          higherIsBetter: metricHigherIsBetter(metric),
          iterations: BENCHMARK_POLICY.bootstrapIterations,
          confidenceLevel: BENCHMARK_POLICY.confidenceLevel,
          seed: stableHash(
            `${result.runId}:${topology.id}:${cell.modelPairId}:${cell.workloadId}:${metric}`
          ),
        })
        cellDecisions.push({
          modelPairId: cell.modelPairId,
          workloadId: cell.workloadId,
          interval,
        })
        if (interval.lower < -BENCHMARK_POLICY.maximumRegression)
        {
          failures.push(
            `${cell.modelPairId}/${cell.workloadId}/${metric} permits more than ` +
              `${BENCHMARK_POLICY.maximumRegression * 100}% regression`
          )
        }
      }
      catch (error)
      {
        failures.push(
          `${cell.modelPairId}/${cell.workloadId}/${metric}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    if (allPairs.length === 0)
    {
      failures.push(`no paired observations for primary metric ${metric}`)
      continue
    }
    try
    {
      const aggregate = pairedBootstrap(allPairs, {
        higherIsBetter: metricHigherIsBetter(metric),
        iterations: BENCHMARK_POLICY.bootstrapIterations,
        confidenceLevel: BENCHMARK_POLICY.confidenceLevel,
        seed: stableHash(`${result.runId}:${topology.id}:aggregate:${metric}`),
      })
      if (aggregate.lower < -BENCHMARK_POLICY.maximumRegression)
      {
        failures.push(
          `aggregate ${metric} permits more than ` +
            `${BENCHMARK_POLICY.maximumRegression * 100}% regression`
        )
      }
      decisions.push({ metric, aggregate, cells: cellDecisions })
    }
    catch (error)
    {
      failures.push(
        `aggregate ${metric}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return { metrics: decisions, failures }
}

function candidateDecision(
  result: BenchmarkResult,
  topology: TopologyIdentity,
  baselinePassed: boolean
): CandidateDecision
{
  const gateFailures = hardGateFailures(result, topology)
  const failures = [...gateFailures]
  if (!baselinePassed)
  {
    failures.push('baseline hard gates did not pass')
  }
  const performance = performanceDecision(result, topology)
  failures.push(...performance.failures)
  const hardGatesPassed = baselinePassed && gateFailures.length === 0
  const performancePassed = performance.failures.length === 0
  const materialImprovement = performance.metrics.some(
    (metric) => metric.aggregate.lower >= BENCHMARK_POLICY.requiredImprovement
  )
  if (!materialImprovement)
  {
    failures.push(
      `no primary metric has a ${BENCHMARK_POLICY.confidenceLevel * 100}% ` +
        `lower bound at or above ${BENCHMARK_POLICY.requiredImprovement * 100}%`
    )
  }
  return {
    topologyId: topology.id,
    hardGatesPassed,
    performancePassed,
    materialImprovement,
    qualified: hardGatesPassed && performancePassed && materialImprovement,
    metrics: performance.metrics,
    failures,
  }
}

function selectQualified(
  result: BenchmarkResult,
  decisions: CandidateDecision[]
): string | undefined
{
  const qualified = decisions.filter((decision) => decision.qualified)
  if (qualified.length === 0) return undefined
  const stock = qualified.find((decision) =>
    result.topologies.some(
      (topology) =>
        topology.id === decision.topologyId && topology.kind === 'stock-mlx'
    )
  )
  if (stock) return stock.topologyId
  return undefined
}

export function decideBenchmark(result: BenchmarkResult): BenchmarkDecision
{
  const failures: string[] = []
  if (result.schemaVersion !== 1) failures.push('unsupported schema version')
  if (result.status !== 'complete')
    failures.push('result status is not complete')
  if (!samePolicy(result))
    failures.push('result policy weakened the fixed policy')
  failures.push(...topologyConfigurationFailures(result))
  failures.push(...observationStructureFailures(result))
  if (result.modelPairs.length < 1)
  {
    failures.push('at least one configured model pair is required')
  }

  const baselines = topologyByRole(result, 'baseline')
  const candidates = topologyByRole(result, 'candidate')
  if (baselines.length !== 1)
  {
    failures.push(`expected one baseline topology, got ${baselines.length}`)
  }
  if (candidates.length === 0)
    failures.push('no candidate topology was recorded')

  const preflightByCandidate = candidates.map((candidate) => ({
    candidate,
    failures: artifactPreflightFailures(result, candidate),
  }))
  if (preflightByCandidate.some((entry) => entry.failures.length > 0))
  {
    const candidateDecisions: CandidateDecision[] = preflightByCandidate.map(
      ({ candidate, failures: preflightFailures }) => ({
        topologyId: candidate.id,
        hardGatesPassed: false,
        performancePassed: false,
        materialImprovement: false,
        qualified: false,
        metrics: [],
        failures: preflightFailures,
      })
    )
    failures.push(
      ...preflightByCandidate.flatMap((entry) => entry.failures),
      'artifact preflight blocked correctness and performance runs'
    )
    return {
      schemaVersion: 1,
      runId: result.runId,
      verdict: 'no-go',
      baselineTopologyId: baselines[0]?.id ?? '',
      candidates: candidateDecisions,
      failures,
      generatedAt: result.provenance.generatedAt,
    }
  }

  const baseline = baselines[0]
  const baselineFailures = baseline ? hardGateFailures(result, baseline) : []
  failures.push(...baselineFailures)
  const candidateDecisions = baseline
    ? candidates.map((candidate) =>
        candidateDecision(result, candidate, baselineFailures.length === 0)
      )
    : []
  const selectedTopologyId = selectQualified(result, candidateDecisions)
  if (!selectedTopologyId)
    failures.push('no candidate cleared every decision gate')

  return {
    schemaVersion: 1,
    runId: result.runId,
    verdict: failures.length === 0 ? 'go' : 'no-go',
    ...(selectedTopologyId ? { selectedTopologyId } : {}),
    baselineTopologyId: baseline?.id ?? '',
    candidates: candidateDecisions,
    failures,
    generatedAt: result.provenance.generatedAt,
  }
}
