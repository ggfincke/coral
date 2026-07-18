// src/utils/git.ts
// shared git command execution helpers

import {
  DEFAULT_CHILD_PROCESS_MAX_BUFFER,
  execFileCommand,
  formatProcessError,
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
  // valid output; keep this off by default so genuine failures are not masked
  allowStdoutOnError?: boolean
}

const DEFAULT_GIT_TIMEOUT = 10_000

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
  const result = await execFileCommand('git', args, {
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
