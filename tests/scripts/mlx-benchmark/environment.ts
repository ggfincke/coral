// tests/scripts/mlx-benchmark/environment.ts
// verify cheap local provenance claims before recording benchmark evidence

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  BenchmarkConfig,
  OllamaTopologyConfig,
  StockMlxTopologyConfig,
} from './types.js'

const execFileAsync = promisify(execFile)

async function output(command: string, args: string[]): Promise<string>
{
  const result = await execFileAsync(command, args, { timeout: 15_000 })
  return result.stdout.trim()
}

function exact(actual: string, expected: string, label: string): void
{
  if (actual !== expected)
  {
    throw new Error(`${label} is ${actual}, expected ${expected}`)
  }
}

function stockTopology(config: BenchmarkConfig): StockMlxTopologyConfig
{
  const topology = config.topologies.find(
    (item): item is StockMlxTopologyConfig => item.kind === 'stock-mlx'
  )
  if (!topology) throw new Error('stock MLX topology is missing')
  return topology
}

async function pythonVersions(
  topology: StockMlxTopologyConfig
): Promise<Record<string, string>>
{
  const projectIndex = topology.launch.args.indexOf('--project')
  const project = topology.launch.args[projectIndex + 1]
  if (projectIndex < 0 || !project)
  {
    throw new Error('stock MLX launch omitted its uv project')
  }
  const script =
    'import importlib.metadata, json, platform; ' +
    'print(json.dumps({"python": platform.python_version(), ' +
    '"mlx": importlib.metadata.version("mlx"), ' +
    '"mlxLm": importlib.metadata.version("mlx-lm")}))'
  const result = await execFileAsync(
    topology.launch.command,
    [
      'run',
      '--frozen',
      '--no-sync',
      '--offline',
      '--project',
      project,
      'python',
      '-c',
      script,
    ],
    {
      cwd: topology.launch.cwd,
      env: topology.launch.env,
      timeout: 15_000,
    }
  )
  const parsed: unknown = JSON.parse(result.stdout)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
  {
    throw new Error('Python provenance probe returned a non-object')
  }
  return parsed as Record<string, string>
}

async function verifyGit(config: BenchmarkConfig): Promise<string>
{
  try
  {
    await execFileAsync(
      '/usr/bin/git',
      ['merge-base', '--is-ancestor', config.software.coralRevision, 'HEAD'],
      { timeout: 15_000 }
    )
  }
  catch
  {
    throw new Error(
      `Coral baseline ${config.software.coralRevision} is not an ancestor of HEAD`
    )
  }
  const committedPaths = await output('/usr/bin/git', [
    'diff',
    '--name-only',
    `${config.software.coralRevision}..HEAD`,
  ])
  const committedOutsideBenchmark = committedPaths
    .split('\n')
    .filter(Boolean)
    .filter(
      (path) =>
        path !== 'tests/scripts/mlx-benchmark-decision.test.ts' &&
        !path.startsWith('tests/scripts/mlx-benchmark/')
    )
  if (committedOutsideBenchmark.length > 0)
  {
    throw new Error(
      `benchmark branch changed production paths: ${committedOutsideBenchmark.join(', ')}`
    )
  }
  const status = await output('/usr/bin/git', [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ])
  const rows = status ? status.split('\n') : []
  const unsafe = rows.filter(
    (row) =>
      !row.startsWith('?? tests/scripts/mlx-benchmark/') &&
      row !== '?? tests/scripts/mlx-benchmark-decision.test.ts'
  )
  if (unsafe.length > 0)
  {
    throw new Error(
      `benchmark worktree has unrelated changes: ${unsafe.join(', ')}`
    )
  }
  return rows.length === 0
    ? `Benchmark branch was clean and contained only benchmark changes above Coral baseline ${config.software.coralRevision}.`
    : `Benchmark worktree contained only the uncommitted PR A construction surface above Coral baseline ${config.software.coralRevision}; rerun at the published commit.`
}

export async function verifyBenchmarkEnvironment(
  config: BenchmarkConfig
): Promise<string[]>
{
  if (process.platform !== 'darwin')
  {
    throw new Error('the configured Apple Silicon benchmark requires macOS')
  }
  exact(process.versions.node, config.software.node, 'Node version')
  const topology = stockTopology(config)
  const uv = await output(topology.launch.command, ['--version'])
  const uvVersion = uv.match(/^uv ([^ ]+)/)?.[1] ?? ''
  exact(uvVersion, config.software.uv, 'uv version')

  const python = await pythonVersions(topology)
  exact(python.python ?? '', config.software.python, 'Python version')
  exact(python.mlx ?? '', config.software.mlx, 'MLX version')
  exact(python.mlxLm ?? '', config.software.mlxLm, 'MLX-LM version')

  const ollamaTopology = config.topologies.find(
    (item): item is OllamaTopologyConfig =>
      item.kind === 'ollama' && item.role === 'baseline'
  )
  if (!ollamaTopology) throw new Error('Ollama baseline topology is missing')
  const ollamaResponse = await fetch(`${ollamaTopology.host}/api/version`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!ollamaResponse.ok)
  {
    throw new Error(`Ollama version probe returned ${ollamaResponse.status}`)
  }
  const ollama = (await ollamaResponse.json()) as Record<string, unknown>
  exact(String(ollama.version ?? ''), config.software.ollama, 'Ollama version')

  const chip = await output('/usr/sbin/sysctl', [
    '-n',
    'machdep.cpu.brand_string',
  ])
  exact(chip, config.machine.chip, 'machine chip')
  const memory = Number(await output('/usr/sbin/sysctl', ['-n', 'hw.memsize']))
  if (memory !== config.machine.unifiedMemoryBytes)
  {
    throw new Error(
      `unified memory is ${memory}, expected ${config.machine.unifiedMemoryBytes}`
    )
  }
  const productVersion = await output('/usr/bin/sw_vers', ['-productVersion'])
  const buildVersion = await output('/usr/bin/sw_vers', ['-buildVersion'])
  exact(
    `macOS ${productVersion} (${buildVersion})`,
    config.machine.os,
    'macOS identity'
  )
  const power = await output('/usr/bin/pmset', ['-g', 'batt'])
  const powerMode = power.includes("'AC Power'")
    ? power.includes('100%')
      ? 'AC power, battery charged'
      : 'AC power, battery not fully charged'
    : 'battery power'
  exact(powerMode, config.machine.powerMode, 'power state')

  return [
    await verifyGit(config),
    'Node, Ollama, uv, Python, MLX, MLX-LM, chip, memory, macOS, and power claims were verified locally before the run.',
  ]
}
