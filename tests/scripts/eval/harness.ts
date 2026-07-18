// tests/scripts/eval/harness.ts
// headless Agent driver, per-rep metric capture, & cross-rep/model aggregation

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Agent,
  type AgentEvents,
  type TokenUsage,
} from '../../../src/agent/agent.js'
import { defaultToolPermissions } from '../../../src/config/permissions.js'
import { DEFAULT_OLLAMA_HOST } from '../../../src/ollama/host.js'
import {
  makeReliabilityStats,
  type ReliabilityStats,
} from '../../../src/types/inference.js'
import {
  addReliability,
  evalTelemetryPath,
  recordReliability,
} from '../../../src/telemetry/store.js'
import type {
  EvalOptions,
  EvalReport,
  EvalTask,
  ModelReport,
  RunMetrics,
  RunOutcome,
  TaskResult,
} from './types.js'

// use bounded defaults when EvalOptions leaves a field unset
const DEFAULT_REPS = 1
const DEFAULT_MAX_ITERATIONS = 15
const DEFAULT_TIMEOUT_MS = 120000

type EvalAgent = Pick<
  Agent,
  'dispose' | 'getMessages' | 'getReliabilityStats' | 'run'
>

interface RunRepDependencies
{
  createAgent?: () => EvalAgent
}

// count only tool-format compensations; other reliability flags stay separate
function countCompensations(stats: ReliabilityStats): number
{
  return (
    stats.repairedToolCalls +
    stats.nameRepairs +
    stats.stallNudges +
    stats.validationFailures +
    stats.editRepairs +
    stats.reprompts
  )
}

// measure tool activity that completed without a compensation
function computeCleanliness(
  toolCallsExecuted: number,
  compensations: number
): number
{
  const denom = toolCallsExecuted + compensations
  if (denom === 0) return 1
  return 1 - compensations / denom
}

// derive throughput from the last usage sample
function computeTokensPerSecond(usage: TokenUsage | undefined): number
{
  if (!usage || usage.totalEvalDurationNs <= 0) return 0
  return usage.totalCompletionTokens / (usage.totalEvalDurationNs / 1e9)
}

// read the agent's final answer from the last assistant message
function extractFinalText(
  messages: { role: string; content: string }[]
): string
{
  for (let i = messages.length - 1; i >= 0; i--)
  {
    const message = messages[i]
    if (message && message.role === 'assistant')
    {
      return message.content
    }
  }
  return ''
}

// run one agent in an isolated scratch dir & capture its metrics
export async function runRep(
  model: string,
  task: EvalTask,
  opts: EvalOptions,
  dependencies: RunRepDependencies = {}
): Promise<RunOutcome>
{
  const host = opts.host ?? DEFAULT_OLLAMA_HOST
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const dir = await mkdtemp(join(tmpdir(), 'coral-eval-'))

  // collect the event counters used by RunMetrics
  let toolCallsExecuted = 0
  let toolErrors = 0
  let lastUsage: TokenUsage | undefined
  let aborted = false
  let errored = false
  let agent: EvalAgent | undefined

  try
  {
    // apply task setup before constructing the agent
    await task.setup(dir)

    agent =
      dependencies.createAgent?.() ??
      new Agent(model, host, dir, {
        maxIterations,
        think: opts.think,
        permissions: defaultToolPermissions(),
      })

    // turn a timeout into the cancellation signal received by Agent.run
    const controller = new AbortController()
    const timer = setTimeout(() =>
    {
      aborted = true
      controller.abort()
    }, timeoutMs)

    // collect only the callbacks needed for the eval metrics
    const events: AgentEvents = {
      onToken: () =>
      {},
      onThinking: () =>
      {},
      onToolCall: () =>
      {},
      onToolResult: (_name, _result, error) =>
      {
        toolCallsExecuted++
        if (error !== undefined) toolErrors++
      },
      // keep eval runs headless by approving gated tools
      onToolApproval: async () => true,
      // stop a run when the agent reports a doom loop
      onDoomLoop: async () => false,
      onVerification: () =>
      {},
      onUsage: (usage) =>
      {
        lastUsage = usage
      },
      onCompactionStart: () =>
      {},
      onCompaction: () =>
      {},
      onDone: () =>
      {},
      onError: () =>
      {
        errored = true
      },
    }

    const startMs = Date.now()

    // contain a failed task as a failed RunOutcome
    try
    {
      await agent.run(task.prompt, events, controller.signal)
    }
    catch
    {
      errored = true
    }
    finally
    {
      clearTimeout(timer)
    }

    const wallMs = Date.now() - startMs

    const messages = agent.getMessages()
    const finalText = extractFinalText(messages)

    let passed = false
    let detail = ''
    try
    {
      const result = await task.grade({ dir, messages, finalText })
      passed = result.passed
      detail = result.detail
    }
    catch (err)
    {
      passed = false
      detail = `grade threw: ${err instanceof Error ? err.message : String(err)}`
    }

    if (aborted || errored)
    {
      const reason =
        aborted && errored ? 'aborted/errored' : aborted ? 'aborted' : 'errored'
      passed = false
      detail = detail ? `${reason}: ${detail}` : reason
    }

    // read reliability after run completion so late updates are included
    const reliability = agent.getReliabilityStats()
    const compensations = countCompensations(reliability)

    const metrics: RunMetrics = {
      toolCallsExecuted,
      toolErrors,
      reliability,
      cleanlinessRate: computeCleanliness(toolCallsExecuted, compensations),
      promptTokens: lastUsage?.totalPromptTokens ?? 0,
      completionTokens: lastUsage?.totalCompletionTokens ?? 0,
      tokensPerSecond: computeTokensPerSecond(lastUsage),
      wallMs,
      aborted,
      errored,
    }

    return { ...metrics, passed, detail }
  }
  catch (err)
  {
    // keep setup & constructor failures inside one failed outcome
    return {
      toolCallsExecuted,
      toolErrors,
      reliability: makeReliabilityStats(),
      cleanlinessRate: computeCleanliness(toolCallsExecuted, 0),
      promptTokens: 0,
      completionTokens: 0,
      tokensPerSecond: 0,
      wallMs: 0,
      aborted,
      errored: true,
      passed: false,
      detail: `run setup failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  finally
  {
    try
    {
      // dispose Agent-owned resources before deleting its workspace
      await agent?.dispose()
    }
    finally
    {
      // remove the scratch dir even when setup, grading, or disposal fails
      await rm(dir, { recursive: true, force: true })
    }
  }
}

// return the arithmetic mean, or zero for an empty set
function mean(values: number[]): number
{
  if (values.length === 0) return 0
  return values.reduce((acc, value) => acc + value, 0) / values.length
}

// return the arithmetic sum, or zero for an empty set
function sum(values: number[]): number
{
  return values.reduce((acc, value) => acc + value, 0)
}

// sum raw reliability counters before persisting one model-level telemetry entry
export function sumReliability(runs: RunOutcome[]): ReliabilityStats
{
  return runs.reduce(
    (acc, run) => addReliability(acc, run.reliability),
    makeReliabilityStats()
  )
}

// average each reliability counter across runs
function meanReliability(runs: RunOutcome[]): ReliabilityStats
{
  if (runs.length === 0) return makeReliabilityStats()
  const n = runs.length
  const mean = makeReliabilityStats()
  for (const key of Object.keys(mean) as (keyof ReliabilityStats)[])
  {
    mean[key] = sum(runs.map((run) => run.reliability[key])) / n
  }
  return mean
}

// aggregate a task's reps using a strict majority & mean metrics
export function aggregateTask(taskId: string, runs: RunOutcome[]): TaskResult
{
  const reps = runs.length
  const passes = runs.filter((r) => r.passed && !r.aborted && !r.errored).length
  // ties fail because a passing result needs a strict majority
  const passed = reps > 0 && passes > reps / 2
  // prefer the first failure detail, else the first run's detail
  const firstFail = runs.find((r) => !r.passed || r.aborted || r.errored)
  const detail = firstFail?.detail ?? runs[0]?.detail ?? ''

  const metrics: RunMetrics = {
    toolCallsExecuted: mean(runs.map((r) => r.toolCallsExecuted)),
    toolErrors: mean(runs.map((r) => r.toolErrors)),
    reliability: meanReliability(runs),
    cleanlinessRate: mean(runs.map((r) => r.cleanlinessRate)),
    promptTokens: mean(runs.map((r) => r.promptTokens)),
    completionTokens: mean(runs.map((r) => r.completionTokens)),
    tokensPerSecond: mean(runs.map((r) => r.tokensPerSecond)),
    wallMs: mean(runs.map((r) => r.wallMs)),
    // preserve any abort or error across the task's reps
    aborted: runs.some((r) => r.aborted),
    errored: runs.some((r) => r.errored),
  }

  return { taskId, reps, passes, passed, detail, metrics }
}

// aggregate per-task results into one model report
export function aggregateModel(
  model: string,
  results: TaskResult[]
): ModelReport
{
  // weight passRate by reps so each run contributes equally
  const totalPasses = results.reduce((sum, r) => sum + r.passes, 0)
  const totalReps = results.reduce((sum, r) => sum + r.reps, 0)
  const passRate = totalReps === 0 ? 0 : totalPasses / totalReps

  return {
    model,
    results,
    passRate,
    meanCleanliness: mean(results.map((r) => r.metrics.cleanlinessRate)),
    meanTokensPerSecond: mean(results.map((r) => r.metrics.tokensPerSecond)),
  }
}

// run tasks sequentially so one local Ollama runner can keep the model warm
export async function runEval(
  models: string[],
  tasks: EvalTask[],
  opts: EvalOptions
): Promise<EvalReport>
{
  const host = opts.host ?? DEFAULT_OLLAMA_HOST
  const reps = opts.reps ?? DEFAULT_REPS

  const filter = opts.taskFilter
  const selectedTasks =
    filter && filter.length > 0
      ? tasks.filter((task) => filter.includes(task.id))
      : tasks

  const modelReports: ModelReport[] = []

  for (const model of models)
  {
    const taskResults: TaskResult[] = []
    const modelRuns: RunOutcome[] = []

    for (const task of selectedTasks)
    {
      const runs: RunOutcome[] = []
      for (let rep = 0; rep < reps; rep++)
      {
        runs.push(await runRep(model, task, { ...opts, host, reps }))
      }
      modelRuns.push(...runs)
      taskResults.push(aggregateTask(task.id, runs))
    }

    modelReports.push(aggregateModel(model, taskResults))

    // persist one model-level entry outside interactive telemetry
    if (opts.saveTelemetry)
    {
      recordReliability(
        model,
        sumReliability(modelRuns),
        new Date().toISOString(),
        evalTelemetryPath()
      )
    }

    // leave model eviction to Ollama's keep_alive policy
  }

  return { models: modelReports, host, reps }
}
