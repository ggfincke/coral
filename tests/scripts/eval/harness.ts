// tests/scripts/eval/harness.ts
// headless Agent driver, per-rep metric capture, & cross-rep/model aggregation

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../../../src/agent/agent.js'
import { defaultToolPermissions } from '../../../src/config/permissions.js'
import type {
  AgentEvents,
  ReliabilityStats,
  TokenUsage,
} from '../../../src/agent/agent.js'
import { DEFAULT_OLLAMA_HOST } from '../../../src/ollama/host.js'
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

// zeroed reliability counters for runs that error before capturing real stats
function emptyReliabilityStats(): ReliabilityStats
{
  return {
    repairedToolCalls: 0,
    nameRepairs: 0,
    stallNudges: 0,
    validationFailures: 0,
    doomLoopTrips: 0,
    reprompts: 0,
    verifyFlags: 0,
  }
}

// compensations = repair/name/stall/validation/reprompt counters. doomLoopTrips
// & verifyFlags are reported but EXCLUDED — they're not tool-format issues
function countCompensations(stats: ReliabilityStats): number
{
  return (
    stats.repairedToolCalls +
    stats.nameRepairs +
    stats.stallNudges +
    stats.validationFailures +
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
  opts: EvalOptions
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

  try
  {
    // seed the scratch dir before the agent sees it
    await task.setup(dir)

    // constructor calls setCwd(dir) (GLOBAL) — reps must run sequentially
    const agent = new Agent(model, host, dir, {
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

    // intentionally no dispose() here — runEval keeps the model warm across a
    // model's tasks & only unloads when switching models

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
      reliability: emptyReliabilityStats(),
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
    // always clean up the scratch dir, even on setup/grade failure
    await rm(dir, { recursive: true, force: true })
  }
}

// arithmetic mean; 0 for an empty set
function mean(values: number[]): number
{
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

// element-wise mean of the reliability counters across runs
function meanReliability(runs: RunOutcome[]): ReliabilityStats
{
  if (runs.length === 0) return emptyReliabilityStats()
  return {
    repairedToolCalls: mean(runs.map((r) => r.reliability.repairedToolCalls)),
    nameRepairs: mean(runs.map((r) => r.reliability.nameRepairs)),
    stallNudges: mean(runs.map((r) => r.reliability.stallNudges)),
    validationFailures: mean(runs.map((r) => r.reliability.validationFailures)),
    doomLoopTrips: mean(runs.map((r) => r.reliability.doomLoopTrips)),
    reprompts: mean(runs.map((r) => r.reliability.reprompts)),
    verifyFlags: mean(runs.map((r) => r.reliability.verifyFlags)),
  }
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

// run every model over every task. tasks run SEQUENTIALLY (Agent.setCwd is
// global), keeping each model warm across its tasks & disposing only on switch
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

    for (const task of selectedTasks)
    {
      const runs: RunOutcome[] = []
      for (let rep = 0; rep < reps; rep++)
      {
        // runRep constructs its own Agent (warm model, fresh scratch dir)
        runs.push(await runRep(model, task, { ...opts, host, reps }))
      }
      taskResults.push(aggregateTask(task.id, runs))
    }

    modelReports.push(aggregateModel(model, taskResults))

    // unload this model before moving on so the next one starts cold & the
    // host frees its KV cache. a fresh disposer agent unloads w/o a run
    const disposer = new Agent(model, host)
    await disposer.dispose()
  }

  return { models: modelReports, host, reps }
}
