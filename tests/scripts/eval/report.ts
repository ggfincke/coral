// tests/scripts/eval/report.ts
// renders an EvalReport as plain aligned text or pretty JSON

import { median } from './harness.js'
import type {
  EvalReport,
  ModelReport,
  RoundSample,
  RunOutcome,
  TaskResult,
} from './types.js'

// format a 0..1 rate as a right-padded percent string
function pct(rate: number): string
{
  return `${(rate * 100).toFixed(0)}%`
}

// format tokens/sec to one decimal
function tps(value: number): string
{
  return value.toFixed(1)
}

// sum the prompt-eval time of the chosen rounds; null when none reported one
function promptEvalMs(samples: RoundSample[]): number | null
{
  const durations = samples.flatMap((sample) =>
    sample.promptEvalDurationNs === null ? [] : [sample.promptEvalDurationNs]
  )
  if (durations.length === 0) return null
  return durations.reduce((sum, ns) => sum + ns, 0) / 1e6
}

// the first round of each turn after the first; a cross-turn prefix break
// makes these re-read the earlier turns
function followUpFirstRounds(run: RunOutcome): RoundSample[]
{
  const rounds = run.rounds ?? []
  return rounds.filter(
    (sample, index) =>
      (sample.turn ?? 1) > 1 && rounds[index - 1]?.turn !== sample.turn
  )
}

// median of one per-rep figure, skipping reps that could not report it
function medianAcrossReps(
  task: TaskResult,
  figure: (run: RunOutcome) => number | null
): number | null
{
  const values = task.runs.flatMap((run) =>
  {
    const value = figure(run)
    return value === null ? [] : [value]
  })
  return values.length === 0 ? null : median(values)
}

// median across reps of total prompt-eval time. prompt_eval_count is the full
// prompt even on a cache hit, so time is the only signal that tracks misses
export function taskPromptEvalMs(task: TaskResult): number | null
{
  return medianAcrossReps(task, (run) => promptEvalMs(run.rounds ?? []))
}

// median across reps of the prompt-eval time spent opening each later turn;
// null for single-turn tasks and reports that predate turn tracking
export function taskFollowUpPrefillMs(task: TaskResult): number | null
{
  return medianAcrossReps(task, (run) => promptEvalMs(followUpFirstRounds(run)))
}

// pad a string to width on the right (left-align)
function padRight(s: string, width: number): string
{
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

// pad a string to width on the left (right-align)
function padLeft(s: string, width: number): string
{
  return s.length >= width ? s : ' '.repeat(width - s.length) + s
}

// format milliseconds as whole seconds
function secs(ms: number): string
{
  return `${(ms / 1000).toFixed(0)}s`
}

// format an optional millisecond figure as seconds w/ one decimal
function prefillSecs(ms: number | null): string
{
  return ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)}s`
}

// one line per task: id, passes/reps, cleanliness, tok/s, wall, prompt-eval
// time, status, detail
function formatTaskLine(task: TaskResult, idWidth: number): string
{
  const status = task.metrics.aborted
    ? 'ABORTED'
    : task.metrics.errored
      ? 'ERRORED'
      : task.passed
        ? 'PASS'
        : 'FAIL'

  const cols = [
    `  ${padRight(task.taskId, idWidth)}`,
    padLeft(`${task.passes}/${task.reps}`, 7),
    padLeft(pct(task.metrics.cleanlinessRate), 6),
    padLeft(tps(task.metrics.tokensPerSecond), 8),
    padLeft(secs(task.metrics.wallMs), 6),
    padLeft(prefillSecs(taskPromptEvalMs(task)), 7),
    padRight(status, 7),
  ]
  const followUp = taskFollowUpPrefillMs(task)
  const followUpNote =
    followUp === null ? '' : `  follow-up prefill ${prefillSecs(followUp)}`

  return `${cols.join('  ')}  ${task.detail}${followUpNote}`
}

// per-model block: summary line then one line per task
function formatModelBlock(model: ModelReport): string
{
  const idWidth = model.results.reduce(
    (max, t) => Math.max(max, t.taskId.length),
    0
  )

  const summary =
    `${model.model}  ` +
    `passRate ${pct(model.passRate)}  ` +
    `cleanliness ${pct(model.meanCleanliness)}  ` +
    `tok/s ${tps(model.meanTokensPerSecond)}  ` +
    `first-round ${model.firstRoundPromptTokens.toFixed(0)} tok`

  const lines = model.results.flatMap((task) => [
    formatTaskLine(task, idWidth),
    ...task.runs.flatMap((run, rep) =>
    {
      const multiTurn = run.rounds.some((sample) => (sample.turn ?? 1) > 1)
      return run.rounds.map((sample) =>
      {
        const duration = (ns: number | null) =>
          ns === null ? 'unavailable' : `${(ns / 1e6).toFixed(1)}ms`
        const turn = multiTurn ? `, turn ${sample.turn ?? 1}` : ''
        return `    rep ${rep + 1} round ${sample.round}${turn}: prompt ${sample.promptTokens}, decode ${sample.completionTokens}, context ~${sample.contextTokens}, prompt time ${duration(sample.promptEvalDurationNs)}, decode time ${duration(sample.evalDurationNs)}, reason ${sample.doneReason ?? 'unavailable'}`
      })
    }),
  ])

  return [summary, ...lines].join('\n')
}

// human-readable report: header, then a block per model
export function formatReport(report: EvalReport): string
{
  const header = `Coral eval — host ${report.host} — reps ${report.reps}`
  const blocks = report.models.map(formatModelBlock)

  return [header, '', ...interleave(blocks)].join('\n')
}

// join model blocks w/ a blank line between them
function interleave(blocks: string[]): string[]
{
  const out: string[] = []

  blocks.forEach((block, i) =>
  {
    if (i > 0)
    {
      out.push('')
    }
    out.push(block)
  })

  return out
}

export function reportToJson(report: EvalReport): string
{
  return JSON.stringify(report, null, 2)
}
