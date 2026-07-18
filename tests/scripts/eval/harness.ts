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

// defaults applied when EvalOptions leaves a field unset
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

// compensations = repair/name/stall/validation/editRepair/reprompt counters.
// doomLoopTrips, verifyFlags, & verifyReprompts are reported but EXCLUDED — not
// tool-format issues
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

// cleanlinessRate = 1 when no calls & no compensations, else the share of
// tool activity that wasn't a compensation
function computeCleanliness(
  toolCallsExecuted: number,
  compensations: number
): number
{
  const denom = toolCallsExecuted + compensations
  if (denom === 0) return 1
  return 1 - compensations / denom
}

// tokens/sec from the last onUsage — completion tokens over eval seconds
function computeTokensPerSecond(usage: TokenUsage | undefined): number
{
  if (!usage || usage.totalEvalDurationNs <= 0) return 0
  return usage.totalCompletionTokens / (usage.totalEvalDurationNs / 1e9)
}

// last assistant message content from the transcript = the agent's final answer
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

// drive one agent run in an isolated scratch dir & capture its metrics + verdict
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

  // fresh per-rep scratch dir under the OS temp root
  const dir = await mkdtemp(join(tmpdir(), 'coral-eval-'))

  // event-loop tallies populated by the stubbed AgentEvents
  let toolCallsExecuted = 0
  let toolErrors = 0
  let lastUsage: TokenUsage | undefined
  let aborted = false
  let errored = false
  let agent: EvalAgent | undefined

  try
  {
    // seed the scratch dir before the agent sees it
    await task.setup(dir)

    // reps run sequentially — one local runner serves every rep, while each
    // rep owns a fresh Agent scope around its throwaway workspace
    agent =
      dependencies.createAgent?.() ??
      new Agent(model, host, dir, {
        maxIterations,
        think: opts.think,
        permissions: defaultToolPermissions(),
      })

    // abort the run on timeout & mark it as aborted
    const controller = new AbortController()
    const timer = setTimeout(() =>
    {
      aborted = true
      controller.abort()
    }, timeoutMs)

    // stub every AgentEvents callback; tallies feed the metrics below
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
      // auto-approve every gated tool so the run is fully headless
      onToolApproval: async () => true,
      // never proceed past a detected doom loop — let the run stop
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

    // a throw escapes run() rarely — onError sets errored; either way one bad
    // task yields a failed RunOutcome instead of aborting the whole suite
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

    // build the final answer from the transcript, then grade
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

    // capture reliability counters AFTER run() resolves
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
    // a setup or constructor failure becomes a failed outcome so the suite keeps going
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
      // release every Agent-local resource before its workspace disappears
      await agent?.dispose()
    }
    finally
    {
      // always clean up the scratch dir, even on setup/grade/disposal failure
      await rm(dir, { recursive: true, force: true })
    }
  }
}

// arithmetic mean; 0 for an empty set
function mean(values: number[]): number
{
  if (values.length === 0) return 0
  return values.reduce((acc, value) => acc + value, 0) / values.length
}

// arithmetic sum; 0 for an empty set
function sum(values: number[]): number
{
  return values.reduce((acc, value) => acc + value, 0)
}

// element-wise sum of the reliability counters across runs (raw totals, not
// means) — what gets folded into the longitudinal eval telemetry store
export function sumReliability(runs: RunOutcome[]): ReliabilityStats
{
  return runs.reduce(
    (acc, run) => addReliability(acc, run.reliability),
    makeReliabilityStats()
  )
}

// element-wise mean of the reliability counters across runs
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

// collapse a task's reps into one result — majority-pass verdict + mean metrics
export function aggregateTask(taskId: string, runs: RunOutcome[]): TaskResult
{
  const reps = runs.length
  const passes = runs.filter((r) => r.passed && !r.aborted && !r.errored).length
  // require a real majority; ties fail
  const passed = reps > 0 && passes > reps / 2
  // surface the first failing detail, else the first run's detail
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
    // aggregate flags are true if any rep tripped them
    aborted: runs.some((r) => r.aborted),
    errored: runs.some((r) => r.errored),
  }

  return { taskId, reps, passes, passed, detail, metrics }
}

// roll a model's per-task results into a single report w/ headline rates
export function aggregateModel(
  model: string,
  results: TaskResult[]
): ModelReport
{
  // passRate weights by reps so a 3-rep task counts more than a 1-rep task
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

// run every model over every task. tasks run SEQUENTIALLY because a single local
// Ollama runner serves every rep — parallel reps would contend for the shared
// host. each request's keep_alive keeps the model warm while Agents close locally
export async function runEval(
  models: string[],
  tasks: EvalTask[],
  opts: EvalOptions
): Promise<EvalReport>
{
  const host = opts.host ?? DEFAULT_OLLAMA_HOST
  const reps = opts.reps ?? DEFAULT_REPS

  // honor the id allowlist when present
  const filter = opts.taskFilter
  const selectedTasks =
    filter && filter.length > 0
      ? tasks.filter((task) => filter.includes(task.id))
      : tasks

  const modelReports: ModelReport[] = []

  // loop models -> tasks -> reps so the active model stays loaded across tasks
  for (const model of models)
  {
    const taskResults: TaskResult[] = []
    // every rep across every task for this model — summed for telemetry below
    const modelRuns: RunOutcome[] = []

    for (const task of selectedTasks)
    {
      const runs: RunOutcome[] = []
      for (let rep = 0; rep < reps; rep++)
      {
        // runRep constructs its own Agent (warm model, fresh scratch dir)
        runs.push(await runRep(model, task, { ...opts, host, reps }))
      }
      modelRuns.push(...runs)
      taskResults.push(aggregateTask(task.id, runs))
    }

    modelReports.push(aggregateModel(model, taskResults))

    // fold this model's summed run reliability into the longitudinal eval store
    // as one entry, keeping eval data out of the interactive telemetry file
    if (opts.saveTelemetry)
    {
      recordReliability(
        model,
        sumReliability(modelRuns),
        new Date().toISOString(),
        evalTelemetryPath()
      )
    }

    // there is no exclusive-host authorization here, so do not issue a
    // host-global eviction; Ollama releases the model after keep_alive expires
  }

  return { models: modelReports, host, reps }
}
