// tests/scripts/mlx-benchmark/config.ts
// strict config loading with explicit environment expansion and no downloads

import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { BenchmarkConfig, BenchmarkRunConfiguration } from './types.js'

const FORENSIC_REVISION = '39a33a45682007333b7db36fd71a4ef171fd81e0'

function expandString(value: string): string
{
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_whole, name) =>
  {
    const replacement = process.env[name]
    if (!replacement)
    {
      throw new Error(`benchmark config requires environment variable ${name}`)
    }
    return replacement
  })
}

function expand(value: unknown): unknown
{
  if (typeof value === 'string') return expandString(value)
  if (Array.isArray(value)) return value.map(expand)
  if (typeof value === 'object' && value !== null)
  {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expand(item)])
    )
  }
  return value
}

function placeholderNames(
  value: unknown,
  names = new Set<string>()
): Set<string>
{
  if (typeof value === 'string')
  {
    for (const match of value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g))
    {
      names.add(match[1]!)
    }
  }
  else if (Array.isArray(value))
  {
    for (const item of value) placeholderNames(item, names)
  }
  else if (typeof value === 'object' && value !== null)
  {
    for (const item of Object.values(value)) placeholderNames(item, names)
  }
  return names
}

function object(value: unknown, label: string): Record<string, unknown>
{
  if (typeof value !== 'object' || value === null || Array.isArray(value))
  {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonempty(value: unknown, label: string): string
{
  if (typeof value !== 'string' || !value.trim())
  {
    throw new Error(`${label} must be a nonempty string`)
  }
  return value
}

function positive(value: unknown, label: string): number
{
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
  {
    throw new Error(`${label} must be a positive number`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number
{
  const number = positive(value, label)
  if (!Number.isInteger(number))
  {
    throw new Error(`${label} must be an integer`)
  }
  return number
}

export function configurationPolicyFailures(
  config: BenchmarkRunConfiguration
): string[]
{
  const failures: string[] = []
  if (config.topologies.length < 3)
  {
    failures.push(
      'configuration requires baseline, stock, and forensic topologies'
    )
  }
  const ids = new Set<string>()
  for (const topology of config.topologies)
  {
    if (ids.has(topology.id))
      failures.push(`duplicate topology id: ${topology.id}`)
    ids.add(topology.id)
    if (topology.kind === 'stock-mlx')
    {
      const args = new Set(topology.launch.args)
      if (
        !topology.launch.command.startsWith('/') ||
        basename(topology.launch.command) !== 'uv'
      )
      {
        failures.push('stock MLX launch must use an absolute uv executable')
      }
      for (const required of ['run', '--frozen', '--no-sync', '--offline'])
      {
        if (!args.has(required))
          failures.push(`stock MLX launch omitted ${required}`)
      }
      if (args.has('--model'))
      {
        failures.push(
          'stock MLX launch must preserve an unloaded server baseline'
        )
      }
      if (args.has('--trust-remote-code'))
      {
        failures.push('stock MLX launch cannot enable remote tokenizer code')
      }
      const pythonEntrypoints = topology.launch.args.filter((arg) =>
        arg.endsWith('.py')
      )
      if (
        pythonEntrypoints.length !== 1 ||
        basename(pythonEntrypoints[0]!) !== 'server_with_metrics.py'
      )
      {
        failures.push('stock MLX launch must use the checked benchmark server')
      }
      if (
        topology.launch.env.UV_PYTHON_DOWNLOADS !== 'never' ||
        topology.launch.env.HF_HUB_OFFLINE !== '1' ||
        topology.launch.env.TRANSFORMERS_OFFLINE !== '1'
      )
      {
        failures.push(
          'stock MLX launch omitted fail-closed offline environment'
        )
      }
      if ('PATH' in topology.launch.env)
      {
        failures.push('stock MLX launch cannot inherit or inject ambient PATH')
      }
    }
    if (
      topology.kind === 'custom-mlx' &&
      (topology.role !== 'forensic' ||
        topology.expectedRevision !== FORENSIC_REVISION)
    )
    {
      failures.push('custom MLX is forensic-only at the immutable PR #64 SHA')
    }
  }
  const baselines = config.topologies.filter(
    (topology) => topology.role === 'baseline' && topology.kind === 'ollama'
  )
  const stock = config.topologies.filter(
    (topology) => topology.role === 'candidate' && topology.kind === 'stock-mlx'
  )
  if (baselines.length !== 1)
  {
    failures.push(
      `configuration requires one Ollama baseline, got ${baselines.length}`
    )
  }
  if (stock.length !== 1)
  {
    failures.push(
      `configuration requires one stock MLX candidate, got ${stock.length}`
    )
  }
  return failures
}

function validateConfig(value: unknown): BenchmarkConfig
{
  const config = object(value, 'benchmark config')
  if (config.configVersion !== 1)
  {
    throw new Error('benchmark configVersion must be 1')
  }
  nonempty(config.runId, 'runId')
  nonempty(config.output, 'output')
  nonempty(config.resultSchema, 'resultSchema')
  positive(config.contextCeiling, 'contextCeiling')
  positive(config.maxOutputTokens, 'maxOutputTokens')
  positive(config.requestTimeoutMs, 'requestTimeoutMs')
  if (config.temperature !== 0) throw new Error('temperature must be exactly 0')
  if (config.topP !== 1) throw new Error('topP must be exactly 1')
  if (!Array.isArray(config.modelPairs) || config.modelPairs.length < 1)
  {
    throw new Error('modelPairs must contain at least one pair')
  }
  if (!Array.isArray(config.topologies) || config.topologies.length < 3)
  {
    throw new Error('topologies must include baseline, stock, and custom')
  }
  const topologyIds = new Set<string>()
  for (const raw of config.topologies)
  {
    const topology = object(raw, 'topology')
    const id = nonempty(topology.id, 'topology.id')
    if (topologyIds.has(id)) throw new Error(`duplicate topology id: ${id}`)
    topologyIds.add(id)
    if (
      topology.kind !== 'ollama' &&
      topology.kind !== 'stock-mlx' &&
      topology.kind !== 'custom-mlx'
    )
    {
      throw new Error(`unsupported topology kind: ${String(topology.kind)}`)
    }
    if (topology.kind === 'stock-mlx')
    {
      if (topology.host !== '127.0.0.1')
      {
        throw new Error('stock MLX host must be exact loopback 127.0.0.1')
      }
      const bindAttempts = positiveInteger(
        topology.bindAttempts,
        'stock MLX bindAttempts'
      )
      if (bindAttempts > 32)
      {
        throw new Error('stock MLX bindAttempts cannot exceed 32')
      }
      positiveInteger(topology.startupTimeoutMs, 'stock MLX startupTimeoutMs')
    }
  }
  const baselineCount = config.topologies.filter(
    (topology) => object(topology, 'topology').role === 'baseline'
  ).length
  if (baselineCount !== 1)
  {
    throw new Error(`config requires one baseline, got ${baselineCount}`)
  }
  const policyFailures = configurationPolicyFailures(
    config as unknown as BenchmarkRunConfiguration
  )
  if (policyFailures.length > 0)
  {
    throw new Error(policyFailures.join('\n'))
  }
  return config as unknown as BenchmarkConfig
}

export async function loadBenchmarkConfig(
  path: string
): Promise<BenchmarkConfig>
{
  const absolute = resolve(path)
  const parsed: unknown = JSON.parse(await readFile(absolute, 'utf8'))
  const raw = object(parsed, 'benchmark config')
  if (
    !Array.isArray(raw.environmentAllowlist) ||
    raw.environmentAllowlist.some(
      (name) => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)
    )
  )
  {
    throw new Error('environmentAllowlist must contain only environment names')
  }
  const allowlist = new Set(raw.environmentAllowlist as string[])
  if (allowlist.size !== raw.environmentAllowlist.length)
  {
    throw new Error('environmentAllowlist cannot contain duplicates')
  }
  for (const name of placeholderNames(parsed))
  {
    if (!allowlist.has(name))
    {
      throw new Error(
        `benchmark config placeholder ${name} is not in environmentAllowlist`
      )
    }
  }
  const config = validateConfig(expand(parsed))
  const base = dirname(absolute)
  return {
    ...config,
    output: resolve(base, config.output),
    resultSchema: resolve(base, config.resultSchema),
    modelPairs: config.modelPairs.map((pair) => ({
      ...pair,
      ollama: {
        ...pair.ollama,
        localPath: resolve(base, pair.ollama.localPath),
      },
      mlx: {
        ...pair.mlx,
        localPath: resolve(base, pair.mlx.localPath),
      },
    })),
    topologies: config.topologies.map((topology) =>
      topology.kind === 'stock-mlx'
        ? {
            ...topology,
            launch: {
              ...topology.launch,
              cwd: resolve(base, topology.launch.cwd),
            },
          }
        : topology.kind === 'custom-mlx'
          ? { ...topology, checkout: resolve(base, topology.checkout) }
          : topology
    ),
  }
}
