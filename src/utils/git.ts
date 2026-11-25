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

// repo-local config can name commands git runs on read (core.fsmonitor) or
// rewrite output; every call disables fsmonitor, and hooks stay enabled for
// the approved mutating tools
export const READ_ONLY_GIT_CONFIG: readonly string[] = Object.freeze([
  '-c',
  'core.fsmonitor=false',
])

// per-subcommand flags that stop config-driven diff drivers, signature checks
// (gpg.program), & color codes; status has no --no-color, so it gets config
function withReadOnlyGitPolicy(args: string[]): string[]
{
  const [subcommand, ...rest] = args
  switch (subcommand)
  {
    case 'diff':
      return [
        ...READ_ONLY_GIT_CONFIG,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        ...rest,
      ]
    case 'log':
      return [
        ...READ_ONLY_GIT_CONFIG,
        'log',
        '--no-color',
        '--no-show-signature',
        ...rest,
      ]
    case 'status':
      return [...READ_ONLY_GIT_CONFIG, '-c', 'color.status=false', ...args]
    default:
      return [...READ_ONLY_GIT_CONFIG, ...args]
  }
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
  const result = await execFileCommand('git', withReadOnlyGitPolicy(args), {
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
