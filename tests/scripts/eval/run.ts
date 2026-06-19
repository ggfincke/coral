// tests/scripts/eval/run.ts
// CLI entry for the model eval harness — drives live Ollama models
// usage: tsx tests/scripts/eval/run.ts <model...> [flags]

import { runEval } from './harness.js'
import { TASKS, taskById } from './tasks.js'
import { formatReport, reportToJson } from './report.js'
import type { EvalOptions, EvalTask } from './types.js'

function fail(message: string): never
{
  console.error(message)
  process.exit(1)
}

// require a flag value so typos don't get parsed as models or empty params
function requireFlagValue(argv: string[], index: number, flag: string): string
{
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--'))
  {
    fail(`${flag} requires a value`)
  }
  return value
}

// fail loudly on a non-positive or NaN numeric flag (e.g. a typo'd value).
// guards reps/maxIterations/timeoutMs from silently producing bogus reports
function requirePositive(value: number | undefined, flag: string): void
{
  if (value === undefined) return
  if (!Number.isFinite(value) || value <= 0)
  {
    fail(`${flag} must be a positive number`)
  }
}

// coerce a --think flag value to the EvalOptions think type
function parseThink(value: string): EvalOptions['think']
{
  const normalized = value.toLowerCase()
  if (
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high'
  )
  {
    return normalized
  }
  if (normalized === 'true' || normalized === 'on')
  {
    return true
  }
  if (normalized === 'false' || normalized === 'off')
  {
    return false
  }
  fail('--think must be one of low, medium, high, on, off, true, or false')
}

function parseNumberFlag(argv: string[], index: number, flag: string): number
{
  return Number(requireFlagValue(argv, index, flag))
}

function printUsageAndExit(): never
{
  fail(
    'usage: tsx tests/scripts/eval/run.ts <model...> ' +
      '[--host <url>] [--reps <n>] [--task <id>]... ' +
      '[--max-iterations <n>] [--timeout <ms>] [--think <mode>] [--json]'
  )
}

// resolve the task set via taskById so unknown ids fail loudly
function resolveTasks(taskFilter: string[]): EvalTask[]
{
  if (taskFilter.length === 0) return TASKS

  return taskFilter.map((id) =>
  {
    const task = taskById(id)
    if (!task)
    {
      fail(`unknown task id: ${id}`)
    }
    return task
  })
}

async function main(): Promise<void>
{
  const argv = process.argv.slice(2)
  const models: string[] = []
  const taskFilter: string[] = []
  const opts: EvalOptions = {}
  let asJson = false

  for (let i = 0; i < argv.length; i++)
  {
    const arg = argv[i]!
    switch (arg)
    {
      case '--host':
        opts.host = requireFlagValue(argv, i, arg)
        i++
        break
      case '--reps':
        opts.reps = parseNumberFlag(argv, i, arg)
        i++
        break
      case '--task':
        taskFilter.push(requireFlagValue(argv, i, arg))
        i++
        break
      case '--max-iterations':
        opts.maxIterations = parseNumberFlag(argv, i, arg)
        i++
        break
      case '--timeout':
        opts.timeoutMs = parseNumberFlag(argv, i, arg)
        i++
        break
      case '--think':
        opts.think = parseThink(requireFlagValue(argv, i, arg))
        i++
        break
      case '--json':
        asJson = true
        break
      default:
        if (arg.startsWith('--'))
        {
          fail(`unknown flag: ${arg}`)
        }
        models.push(arg)
        break
    }
  }

  if (taskFilter.length > 0)
  {
    opts.taskFilter = taskFilter
  }

  if (models.length === 0)
  {
    printUsageAndExit()
  }

  // reject NaN/non-positive numeric flags so a typo can't fake a green report
  requirePositive(opts.reps, '--reps')
  requirePositive(opts.maxIterations, '--max-iterations')
  requirePositive(opts.timeoutMs, '--timeout')

  const report = await runEval(models, resolveTasks(taskFilter), opts)

  console.log(asJson ? reportToJson(report) : formatReport(report))
}

void main()
