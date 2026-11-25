// src/utils/git.ts
// shared git command execution helpers

import {
  DEFAULT_CHILD_PROCESS_MAX_BUFFER,
  execFileCommand,
  formatProcessError,
  type ChildProcessFailure,
} from './process.js'

export interface GitCommandResult
{
  output: string
  error?: string
}

export interface GitCommandOptions
{
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
  // treat a non-zero exit with stdout as success because git diff can exit 1 with
  // valid output; a timeout or buffer overflow still fails so a cut diff is
  // never returned as complete
  allowStdoutOnError?: boolean
}

const DEFAULT_GIT_TIMEOUT = 10_000

// hook events a read or a task checkout can fire (index refresh, checkout,
// ref update); config-defined hooks ignore core.hooksPath
const READ_HOOK_EVENTS = [
  'post-index-change',
  'post-checkout',
  'reference-transaction',
]

// core.fsmonitor names a command git runs on any index refresh, so every
// call disables it, mutating ones included
const NO_FSMONITOR = ['-c', 'core.fsmonitor=false']

// repo-local config can name commands git runs on read; read-only callers
// get no fsmonitor & no hooks, while the approved mutating tools keep hooks
export const READ_ONLY_GIT_CONFIG: readonly string[] = Object.freeze([
  ...NO_FSMONITOR,
  '-c',
  'core.hooksPath=/dev/null',
  ...READ_HOOK_EVENTS.flatMap((event) => ['-c', `hook.${event}.enabled=false`]),
])

// subcommands the approval-gated tools run; they keep hooks & filter drivers
const MUTATING_SUBCOMMANDS = new Set(['add', 'commit', 'switch', 'push'])

// '-c' splits at the first '=', so a name holding one cannot be addressed
function configName(name: string): string | undefined
{
  return name && !name.includes('=') ? name : undefined
}

// split 'section.sub.section.var' into its subsection & variable
function configSubsection(
  key: string,
  section: string
): { name: string; variable: string } | undefined
{
  const last = key.lastIndexOf('.')
  if (!key.startsWith(`${section}.`) || last <= section.length) return undefined
  return {
    name: key.slice(section.length + 1, last),
    variable: key.slice(last + 1),
  }
}

// turn configured hook & filter entries into '-c' overrides that disable them:
// each hook event & named hook, & every filter driver (clean, smudge, process)
function disableConfiguredCommands(
  entries: Array<{ key: string; value: string }>
): { args: string[] } | { error: string }
{
  const overrides = new Set<string>()
  for (const { key, value } of entries)
  {
    const hook = configSubsection(key, 'hook')
    if (hook)
    {
      const name = configName(hook.name)
      if (name) overrides.add(`hook.${name}.enabled=false`)
      const event = hook.variable === 'event' ? configName(value) : undefined
      if (event) overrides.add(`hook.${event}.enabled=false`)
      continue
    }
    const filter = configSubsection(key, 'filter')
    if (!filter) continue
    const name = configName(filter.name)
    if (!name)
    {
      return {
        error: `git config defines a filter driver that cannot be disabled: ${filter.name}`,
      }
    }
    for (const variable of ['clean', 'smudge', 'process'])
    {
      overrides.add(`filter.${name}.${variable}=`)
    }
    overrides.add(`filter.${name}.required=false`)
  }
  return { args: [...overrides].flatMap((override) => ['-c', override]) }
}

// read hook & filter config without running anything, so a read-only call can
// switch off every configured command; exit 1 means no matching keys
async function readOnlyConfigOverrides(
  cwd: string,
  options: { timeout: number; maxBuffer: number; signal?: AbortSignal }
): Promise<{ args: string[] } | { error: string }>
{
  const result = await execFileCommand(
    'git',
    ['config', '-z', '--get-regexp', '^(hook|filter)\\.'],
    { cwd, ...options }
  )
  if (!result.ok)
  {
    if (result.code === 1 && !result.stdout && !result.signal)
    {
      return { args: [] }
    }
    return {
      error: formatProcessError(result, { fallback: 'git config failed' }),
    }
  }
  const entries = result.stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) =>
    {
      const newline = entry.indexOf('\n')
      return newline === -1
        ? { key: entry, value: '' }
        : { key: entry.slice(0, newline), value: entry.slice(newline + 1) }
    })
  return disableConfiguredCommands(entries)
}

// per-subcommand flags that stop config-driven diff drivers, signature checks
// (gpg.program), & color codes; status has no --no-color, so it gets config
function withReadOnlyGitPolicy(args: string[], overrides: string[]): string[]
{
  const [subcommand, ...rest] = args
  const config = [...READ_ONLY_GIT_CONFIG, ...overrides]
  switch (subcommand)
  {
    case 'diff':
      return [
        ...config,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        ...rest,
      ]
    case 'log':
      return [...config, 'log', '--no-color', '--no-show-signature', ...rest]
    case 'status':
      return [...config, '-c', 'color.status=false', ...args]
    default:
      return [...config, ...args]
  }
}

// mutating subcommands only lose fsmonitor; read-only ones lose every
// configured hook & filter command as well
async function withGitPolicy(
  args: string[],
  cwd: string,
  options: { timeout: number; maxBuffer: number; signal?: AbortSignal }
): Promise<{ args: string[] } | { error: string }>
{
  if (MUTATING_SUBCOMMANDS.has(args[0] ?? ''))
  {
    return { args: [...NO_FSMONITOR, ...args] }
  }
  const overrides = await readOnlyConfigOverrides(cwd, options)
  if ('error' in overrides) return overrides
  return { args: withReadOnlyGitPolicy(args, overrides.args) }
}

// explain a run git did not finish on its own; undefined for a normal exit
function interruptedGitError(
  result: ChildProcessFailure,
  timeout: number,
  maxBuffer: number
): string | undefined
{
  const stderr = result.stderr.trim()
  const withStderr = (reason: string): string =>
    stderr ? `${reason}\n${stderr}` : reason
  if (result.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  {
    return withStderr(
      `git output exceeded ${maxBuffer} bytes and was cut off; narrow the request`
    )
  }
  if (result.signal)
  {
    return withStderr(`git did not finish within ${timeout} ms`)
  }
  return undefined
}

// return trimmed raw output; display placeholders belong to the calling layer
// so batched read tools can overlap without blocking on a slow repository
export async function runGitCommand(
  args: string[],
  cwd: string,
  options: GitCommandOptions = {}
): Promise<GitCommandResult>
{
  const {
    timeout = DEFAULT_GIT_TIMEOUT,
    maxBuffer = DEFAULT_CHILD_PROCESS_MAX_BUFFER,
    signal,
    allowStdoutOnError = false,
  } = options

  signal?.throwIfAborted()
  const policy = await withGitPolicy(args, cwd, { timeout, maxBuffer, signal })
  signal?.throwIfAborted()
  if ('error' in policy) return { output: '', error: policy.error }
  const result = await execFileCommand('git', policy.args, {
    cwd,
    timeout,
    maxBuffer,
    signal,
  })
  signal?.throwIfAborted()
  if (result.ok)
  {
    return { output: result.stdout.trimEnd() }
  }

  // a timeout or maxBuffer kill leaves partial stdout behind, so report the
  // cut instead of returning it as complete output
  const interrupted = interruptedGitError(result, timeout, maxBuffer)
  if (interrupted) return { output: '', error: interrupted }

  if (allowStdoutOnError && result.stdout)
  {
    return { output: result.stdout.trimEnd() }
  }

  return {
    output: '',
    error: formatProcessError(result, {
      includeStdout: true,
      fallback: 'git command failed',
    }),
  }
}

// branch name, or detached@<sha> / unknown when HEAD is detached or unborn
export async function currentBranchLabel(
  cwd: string,
  signal?: AbortSignal
): Promise<string>
{
  const branch = await runGitCommand(['branch', '--show-current'], cwd, {
    signal,
  })
  if (!branch.error && branch.output.trim()) return branch.output.trim()

  const sha = await runGitCommand(['rev-parse', '--short', 'HEAD'], cwd, {
    signal,
  })
  return !sha.error && sha.output.trim()
    ? `detached@${sha.output.trim()}`
    : 'unknown'
}
