// tests/scripts/eval/report.ts
// renders an EvalReport as plain aligned text or pretty JSON

import type { EvalReport, ModelReport, TaskResult } from './types.js'

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

// one line per task: id, passes/reps, cleanliness, tok/s, status, detail
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
    `tok/s ${tps(model.meanTokensPerSecond)}`

  const lines = model.results.map((t) => formatTaskLine(t, idWidth))

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
