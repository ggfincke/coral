// tests/scripts/mlx-benchmark/run.ts
// command-line entry for preflight, live collection, and decision validation

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadBenchmarkConfig } from './config.js'
import { decideBenchmark } from './decision.js'
import {
  formatDecisionMarkdown,
  formatForensicMarkdown,
  formatModelEvidenceMarkdown,
} from './report.js'
import { loadBenchmarkResult, saveBenchmarkJson } from './result-io.js'
import { runBenchmark } from './runner.js'

function flag(args: string[], name: string): string | undefined
{
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--'))
  {
    throw new Error(`${name} requires a value`)
  }
  return value
}

function usage(): never
{
  throw new Error(
    'usage:\n' +
      '  npx --no-install tsx tests/scripts/mlx-benchmark/run.ts run ' +
      '--config <path>\n' +
      '  npx --no-install tsx tests/scripts/mlx-benchmark/run.ts validate ' +
      '--result <path> ' +
      '--schema <path> [--decision <path>] [--markdown <path>]'
  )
}

function siblingPath(
  resultPath: string,
  suffix: 'decision.json' | 'decision.md'
): string
{
  return resultPath.endsWith('.result.json')
    ? `${resultPath.slice(0, -'.result.json'.length)}.${suffix}`
    : resultPath.replace(/\.json$/, `.${suffix}`)
}

async function main(): Promise<void>
{
  const [command, ...args] = process.argv.slice(2)
  if (command === 'run')
  {
    const configPath = flag(args, '--config') ?? usage()
    const config = await loadBenchmarkConfig(configPath)
    await runBenchmark(config)
    const result = await loadBenchmarkResult(config.output, config.resultSchema)
    const decision = decideBenchmark(result)
    const decisionPath = siblingPath(config.output, 'decision.json')
    const markdownPath = siblingPath(config.output, 'decision.md')
    saveBenchmarkJson(decisionPath, decision)
    await writeFile(
      markdownPath,
      formatDecisionMarkdown(decision, result) +
        `\n${formatModelEvidenceMarkdown(result.modelPairs)}` +
        `\n${formatForensicMarkdown(result.forensicFindings)}`,
      'utf8'
    )
    process.stdout.write(
      `${decision.verdict}: ${config.output}\n${decisionPath}\n${markdownPath}\n`
    )
    if (decision.verdict === 'no-go') process.exitCode = 2
    return
  }
  if (command === 'validate')
  {
    const resultPath = resolve(flag(args, '--result') ?? usage())
    const schemaPath = resolve(flag(args, '--schema') ?? usage())
    const decisionPath = resolve(
      flag(args, '--decision') ?? siblingPath(resultPath, 'decision.json')
    )
    const markdownPath = resolve(
      flag(args, '--markdown') ?? siblingPath(resultPath, 'decision.md')
    )
    const result = await loadBenchmarkResult(resultPath, schemaPath)
    const decision = decideBenchmark(result)
    saveBenchmarkJson(decisionPath, decision)
    await writeFile(
      markdownPath,
      formatDecisionMarkdown(decision, result) +
        `\n${formatModelEvidenceMarkdown(result.modelPairs)}` +
        `\n${formatForensicMarkdown(result.forensicFindings)}`,
      'utf8'
    )
    process.stdout.write(
      `${decision.verdict}: ${decisionPath}\n${markdownPath}\n`
    )
    if (decision.verdict === 'no-go') process.exitCode = 2
    return
  }
  usage()
}

void main().catch((error: unknown) =>
{
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exitCode = 1
})
