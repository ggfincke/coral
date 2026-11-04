// tests/scripts/eval/compare.ts
// diff two saved --json eval reports per model and per task

import type { EvalReport, ModelReport, TaskResult } from './types.js'

// the task-level numbers worth tracking between runs; wall and prompt tokens
// catch prompt-size regressions that pass rate alone hides
interface TaskFigures
{
  passRate: number
  cleanliness: number
  wallMs: number
  promptTokens: number
  // null when the report predates the field, so the delta prints n/a
  // instead of a fake regression against zero
  firstRoundPromptTokens: number | null
}

function taskFigures(task: TaskResult): TaskFigures
{
  return {
    passRate: task.reps === 0 ? 0 : task.passes / task.reps,
    cleanliness: task.metrics.cleanlinessRate,
    wallMs: task.metrics.wallMs,
    promptTokens: task.metrics.promptTokens,
    firstRoundPromptTokens: task.metrics.firstRoundPromptTokens ?? null,
  }
}

// signed delta w/ a unit; rates print as percentage points
function deltaPct(before: number, after: number): string
{
  const points = (after - before) * 100
  const sign = points > 0 ? '+' : ''
  return `${sign}${points.toFixed(0)}pp`
}

function deltaNum(before: number, after: number, unit: string): string
{
  const diff = after - before
  const sign = diff > 0 ? '+' : ''
  const relative =
    before === 0 ? '' : ` (${sign}${((diff / before) * 100).toFixed(0)}%)`
  return `${sign}${Math.round(diff)}${unit}${relative}`
}

function padRight(s: string, width: number): string
{
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

// one line per task present in both reports; tasks on one side only are
// listed so a renamed or added task is not silently dropped
function formatModelComparison(
  before: ModelReport,
  after: ModelReport
): string[]
{
  const beforeTasks = new Map(before.results.map((t) => [t.taskId, t]))
  const afterTasks = new Map(after.results.map((t) => [t.taskId, t]))
  const shared = [...beforeTasks.keys()].filter((id) => afterTasks.has(id))
  const idWidth = shared.reduce((max, id) => Math.max(max, id.length), 0)

  const lines = [
    `${before.model}  ` +
      `passRate ${deltaPct(before.passRate, after.passRate)}  ` +
      `cleanliness ${deltaPct(before.meanCleanliness, after.meanCleanliness)}  ` +
      `tok/s ${deltaNum(before.meanTokensPerSecond, after.meanTokensPerSecond, '')}`,
  ]

  for (const id of shared)
  {
    const a = taskFigures(beforeTasks.get(id)!)
    const b = taskFigures(afterTasks.get(id)!)
    lines.push(
      `  ${padRight(id, idWidth)}  ` +
        `pass ${deltaPct(a.passRate, b.passRate)}  ` +
        `clean ${deltaPct(a.cleanliness, b.cleanliness)}  ` +
        `wall ${deltaNum(a.wallMs, b.wallMs, 'ms')}  ` +
        `prompt ${deltaNum(a.promptTokens, b.promptTokens, ' tok')}  ` +
        `first-round ${
          a.firstRoundPromptTokens === null || b.firstRoundPromptTokens === null
            ? 'n/a'
            : deltaNum(
                a.firstRoundPromptTokens,
                b.firstRoundPromptTokens,
                ' tok'
              )
        }`
    )
  }

  const onlyBefore = [...beforeTasks.keys()].filter((id) => !afterTasks.has(id))
  const onlyAfter = [...afterTasks.keys()].filter((id) => !beforeTasks.has(id))
  if (onlyBefore.length > 0)
  {
    lines.push(`  only in before: ${onlyBefore.join(', ')}`)
  }
  if (onlyAfter.length > 0)
  {
    lines.push(`  only in after: ${onlyAfter.join(', ')}`)
  }

  return lines
}

// render deltas (after minus before) for every model present in both reports
export function formatComparison(
  before: EvalReport,
  after: EvalReport
): string
{
  const afterModels = new Map(after.models.map((m) => [m.model, m]))
  const blocks: string[][] = []

  for (const model of before.models)
  {
    const counterpart = afterModels.get(model.model)
    if (counterpart === undefined) continue
    blocks.push(formatModelComparison(model, counterpart))
  }

  if (blocks.length === 0)
  {
    return 'no model appears in both reports'
  }

  const header = [
    `Coral eval compare (after minus before)`,
    `before: host ${before.host}, reps ${before.reps}`,
    `after:  host ${after.host}, reps ${after.reps}`,
    '',
  ]
  const body = blocks.flatMap((block, i) => (i > 0 ? ['', ...block] : block))

  return [...header, ...body].join('\n')
}
