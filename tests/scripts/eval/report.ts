// tests/scripts/eval/report.ts
// renders an EvalReport as plain aligned text or pretty JSON

import type {
  EvalReport,
  ModelReport,
  RoundSample,
  TaskResult,
} from './types.js'

// a later round that prefilled at least this share of its context missed the
// prefix cache (cache hits only re-read the new tail)
const COLD_PREFILL_FRACTION = 0.9

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

// share of the planned context that ollama actually prefilled this round;
// near 100% means the prefix cache missed and the whole prompt was re-read
function prefillFraction(sample: RoundSample): number
{
  if (sample.contextTokens <= 0) return 0
  return Math.min(1, sample.promptTokens / sample.contextTokens)
}

// list the rounds after the first that re-prefilled most of the prompt
function formatColdRounds(rounds: RoundSample[]): string
{
  const cold = rounds
    .filter(
      (sample) =>
        sample.round > 1 && prefillFraction(sample) >= COLD_PREFILL_FRACTION
    )
    .map((sample) => sample.round)
  return cold.length === 0 ? 'none' : cold.join(', ')
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

// mean prefill share across every round of every rep; high means the prefix
// cache is missing and each round re-reads the whole prompt
function taskPrefill(task: TaskResult): number
{
  const samples = task.runs.flatMap((run) => run.rounds)
  if (samples.length === 0) return 0
  return (
    samples.reduce((sum, sample) => sum + prefillFraction(sample), 0) /
    samples.length
  )
}

// one line per task: id, passes/reps, cleanliness, tok/s, wall, prefill,
// status, detail
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
    padLeft(pct(taskPrefill(task)), 6),
    padRight(status, 7),
  ]

  return `${cols.join('  ')}  ${task.detail}`
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
    ...task.runs.flatMap((run, rep) => [
      ...run.rounds.map((sample) =>
      {
        const duration = (ns: number | null) =>
          ns === null ? 'unavailable' : `${(ns / 1e6).toFixed(1)}ms`
        return `    rep ${rep + 1} round ${sample.round}: prompt ${sample.promptTokens}, decode ${sample.completionTokens}, context ~${sample.contextTokens}, prefill ${pct(prefillFraction(sample))}, prompt time ${duration(sample.promptEvalDurationNs)}, decode time ${duration(sample.evalDurationNs)}, reason ${sample.doneReason ?? 'unavailable'}`
      }),
      `    rep ${rep + 1} cold rounds: ${formatColdRounds(run.rounds)}`,
    ]),
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
