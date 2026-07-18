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
  // treat a non-zero exit w/ stdout as success (git diff exits 1 w/ valid output
  // in some configs) — off by default so genuine failures aren't masked
  allowStdoutOnError?: boolean
}

const DEFAULT_GIT_TIMEOUT = 10_000

// returns trimmed raw output (empty string when git produced none) — the
// display placeholder for empties belongs to the calling tool/display layer.
// async so batched read tools overlap & never block the event loop on a slow repo
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
