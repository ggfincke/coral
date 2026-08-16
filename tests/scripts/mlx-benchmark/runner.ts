// tests/scripts/mlx-benchmark/runner.ts
// resumable benchmark orchestration with preflight-first early no-go

import { BENCHMARK_POLICY, PERFORMANCE_WORKLOADS } from './manifest.js'
import { verifyBenchmarkEnvironment } from './environment.js'
import { runArtifactPreflight, runBaselineSmoke } from './preflight.js'
import { processTreeRss } from './process.js'
import {
  createRuntimes,
  verifyCandidateRevision,
  type BenchmarkRuntime,
} from './providers.js'
import { saveBenchmarkResult } from './result-io.js'
import {
  measurePerformanceWorkload,
  preparePerformanceWorkload,
  runContextGates,
  runCorrectnessGates,
  runCrossRuntimeResidencyGate,
  runLifecycleGates,
  runSameModelResidencyGate,
  runToolGates,
} from './suites.js'
import type {
  BenchmarkConfig,
  BenchmarkResult,
  HardGateObservation,
  PerformanceCell,
} from './types.js'

function captureEnvironment(names: string[]): Record<string, string>
{
  return Object.fromEntries(
    names
      .map((name) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
  )
}

function initialResult(
  config: BenchmarkConfig,
  runtimes: BenchmarkRuntime[],
  environmentNotes: string[]
): BenchmarkResult
{
  return {
    schemaVersion: 1,
    runId: config.runId,
    status: 'pending',
    provenance: {
      generatedAt: new Date().toISOString(),
      machine: config.machine,
      software: config.software,
      command: process.argv,
      environment: captureEnvironment(config.environmentAllowlist),
      notes: [
        'Configurations compare shippable Coral runtimes, not identical-weight backend science.',
        'No benchmark command may download a model or sync a Python environment.',
        'The installed Ollama NVFP4 tensor layout is not a stock MLX-LM model directory; conversion is outside this benchmark.',
        'The immutable forensic checkout HEAD and clean status were verified before evidence creation.',
        ...environmentNotes,
      ],
    },
    policy: { ...BENCHMARK_POLICY },
    configuration: {
      contextCeiling: config.contextCeiling,
      maxOutputTokens: config.maxOutputTokens,
      requestTimeoutMs: config.requestTimeoutMs,
      temperature: config.temperature,
      topP: config.topP,
      topologies: config.topologies,
    },
    topologies: runtimes.map((runtime) => runtime.identity),
    forensicFindings: runtimes
      .filter((runtime) => runtime.identity.role === 'forensic')
      .map((runtime) => ({
        topologyId: runtime.identity.id,
        immutableRevision: runtime.identity.immutableRevision,
        disposition: 'disqualified' as const,
        findings: [
          'ordinary model-picker activation eagerly starts Python work',
          'handwritten family parsing does not use the pinned tokenizer-native Qwen contract',
          'malformed or mismatched frames can poison generation and pending transport state',
          'cancellation, restart, descendant cleanup, and A-B-A residency are not lifecycle-complete',
        ],
      })),
    modelPairs: config.modelPairs,
    baselineSmokes: [],
    hardGates: [],
    performanceCells: [],
  }
}

function nextSequence(result: BenchmarkResult): number
{
  return result.hardGates.reduce(
    (max, observation) => Math.max(max, observation.sequence + 1),
    1
  )
}

function addRows(
  result: BenchmarkResult,
  rows: HardGateObservation[],
  output: string
): void
{
  result.hardGates.push(...rows)
  saveBenchmarkResult(output, result)
}

async function runHardGates(
  config: BenchmarkConfig,
  result: BenchmarkResult,
  runtimes: BenchmarkRuntime[]
): Promise<void>
{
  const baseline = runtimes.find(
    (runtime) => runtime.identity.role === 'baseline'
  )
  if (!baseline) throw new Error('benchmark baseline runtime was missing')
  const candidates = runtimes.filter(
    (runtime) => runtime.identity.role === 'candidate'
  )
  for (const pair of config.modelPairs)
  {
    for (const runtime of [baseline, ...candidates])
    {
      addRows(
        result,
        await runCorrectnessGates(runtime, pair, nextSequence(result), config),
        config.output
      )
      addRows(
        result,
        await runToolGates(runtime, pair, nextSequence(result), config),
        config.output
      )
      addRows(
        result,
        await runContextGates(
          runtime,
          pair,
          config.contextCeiling,
          nextSequence(result),
          config
        ),
        config.output
      )
      addRows(
        result,
        await runLifecycleGates(runtime, pair, nextSequence(result), config),
        config.output
      )
      addRows(
        result,
        await runSameModelResidencyGate(
          runtime,
          pair,
          nextSequence(result),
          config
        ),
        config.output
      )
    }
    for (const candidate of candidates)
    {
      addRows(
        result,
        await runCrossRuntimeResidencyGate(
          candidate,
          baseline,
          pair,
          nextSequence(result),
          config
        ),
        config.output
      )
    }
  }
}

async function performanceCell(
  config: BenchmarkConfig,
  baseline: BenchmarkRuntime,
  candidate: BenchmarkRuntime,
  modelPairId: string,
  workloadId: string
): Promise<PerformanceCell>
{
  const pair = config.modelPairs.find((item) => item.id === modelPairId)
  const workload = PERFORMANCE_WORKLOADS.find((item) => item.id === workloadId)
  if (!pair || !workload) throw new Error('unknown performance cell')

  const baselinePrepared = await preparePerformanceWorkload(
    baseline,
    pair,
    workload.id,
    config.contextCeiling,
    config
  )
  const candidatePrepared = await preparePerformanceWorkload(
    candidate,
    pair,
    workload.id,
    config.contextCeiling,
    config
  )

  await baseline.resetModel(pair)
  const baselineUnloadedRss = (
    await processTreeRss(
      [process.pid, ...baseline.processRoots()],
      candidate.processRoots()
    )
  ).rssBytes
  await candidate.resetModel(pair)
  const candidateUnloadedRss = (
    await processTreeRss([process.pid, ...candidate.processRoots()])
  ).rssBytes

  for (let warmup = 0; warmup < BENCHMARK_POLICY.warmups; warmup++)
  {
    await measurePerformanceWorkload(
      baseline,
      pair,
      workload.id,
      workload.resetModel,
      config.contextCeiling,
      config,
      baselinePrepared,
      baselineUnloadedRss,
      () => candidate.processRoots()
    )
    await measurePerformanceWorkload(
      candidate,
      pair,
      workload.id,
      workload.resetModel,
      config.contextCeiling,
      config,
      candidatePrepared,
      candidateUnloadedRss
    )
  }

  const samples: PerformanceCell['samples'] = []
  for (let index = 0; index < BENCHMARK_POLICY.measuredRuns; index++)
  {
    const baselineFirst = index % 2 === 0
    const runBaseline = () =>
      measurePerformanceWorkload(
        baseline,
        pair,
        workload.id,
        workload.resetModel,
        config.contextCeiling,
        config,
        baselinePrepared,
        baselineUnloadedRss,
        () => candidate.processRoots()
      )
    const runCandidate = () =>
      measurePerformanceWorkload(
        candidate,
        pair,
        workload.id,
        workload.resetModel,
        config.contextCeiling,
        config,
        candidatePrepared,
        candidateUnloadedRss
      )
    const first = baselineFirst ? await runBaseline() : await runCandidate()
    const second = baselineFirst ? await runCandidate() : await runBaseline()
    samples.push({
      pairIndex: index + 1,
      order: baselineFirst ? 'baseline-first' : 'candidate-first',
      baseline: baselineFirst ? first : second,
      candidate: baselineFirst ? second : first,
    })
  }
  return {
    candidateTopologyId: candidate.identity.id,
    modelPairId,
    workloadId,
    warmupsCompleted: BENCHMARK_POLICY.warmups,
    metrics: [...workload.metrics],
    samples,
  }
}

async function runPerformance(
  config: BenchmarkConfig,
  result: BenchmarkResult,
  runtimes: BenchmarkRuntime[]
): Promise<void>
{
  const baseline = runtimes.find(
    (runtime) => runtime.identity.role === 'baseline'
  )
  if (!baseline) throw new Error('benchmark baseline runtime was missing')
  const candidates = runtimes.filter(
    (runtime) => runtime.identity.role === 'candidate'
  )
  for (const candidate of candidates)
  {
    for (const pair of config.modelPairs)
    {
      for (const workload of PERFORMANCE_WORKLOADS)
      {
        result.performanceCells.push(
          await performanceCell(
            config,
            baseline,
            candidate,
            pair.id,
            workload.id
          )
        )
        saveBenchmarkResult(config.output, result)
      }
    }
  }
}

export async function runBenchmark(
  config: BenchmarkConfig
): Promise<BenchmarkResult>
{
  const environmentNotes = await verifyBenchmarkEnvironment(config)
  for (const topology of config.topologies)
  {
    if (topology.kind === 'custom-mlx')
    {
      await verifyCandidateRevision(topology)
    }
  }
  const runtimes = createRuntimes(config)
  const result = initialResult(config, runtimes, environmentNotes)
  saveBenchmarkResult(config.output, result)

  const ollamaConfig = config.topologies.find(
    (topology) => topology.kind === 'ollama' && topology.role === 'baseline'
  )
  if (!ollamaConfig || ollamaConfig.kind !== 'ollama')
  {
    throw new Error('benchmark config omitted the Ollama baseline')
  }
  for (const pair of config.modelPairs)
  {
    result.baselineSmokes.push(
      await runBaselineSmoke(ollamaConfig, pair, config.requestTimeoutMs)
    )
  }
  saveBenchmarkResult(config.output, result)

  for (const runtime of runtimes.filter(
    (item) => item.identity.role !== 'baseline'
  ))
  {
    for (const pair of config.modelPairs)
    {
      result.hardGates.push(
        await runArtifactPreflight(runtime.identity, pair, nextSequence(result))
      )
    }
  }
  saveBenchmarkResult(config.output, result)

  const candidateIds = new Set(
    runtimes
      .filter((runtime) => runtime.identity.role === 'candidate')
      .map((runtime) => runtime.identity.id)
  )
  const preflightFailed = result.hardGates.some(
    (gate) =>
      candidateIds.has(gate.topologyId) &&
      gate.category === 'artifact-availability' &&
      !gate.passed
  )
  if (preflightFailed)
  {
    result.status = 'complete'
    result.provenance.notes.push(
      'The pinned direct snapshot was metadata-only locally; the run stopped before MLX launch.'
    )
    saveBenchmarkResult(config.output, result)
    return result
  }

  const active = runtimes.filter(
    (runtime) => runtime.identity.role !== 'forensic'
  )
  try
  {
    for (const runtime of active) await runtime.start(config.modelPairs[0]!)
    await runHardGates(config, result, active)
    await runPerformance(config, result, active)
    result.status = 'complete'
    saveBenchmarkResult(config.output, result)
    return result
  }
  finally
  {
    for (const runtime of active.reverse()) await runtime.stop()
  }
}
