// src/utils/git.ts
// shared git command execution helpers

import { execFileSync } from 'node:child_process'

export interface GitCommandResult
{
  output: string
  error?: string
}

export interface GitCommandOptions
{
  timeout?: number
  maxBuffer?: number
  // treat a non-zero exit w/ stdout as success (git diff exits 1 w/ valid output
  // in some configs) — off by default so genuine failures aren't masked
  allowStdoutOnError?: boolean
}

const DEFAULT_GIT_TIMEOUT = 10_000
const DEFAULT_GIT_MAX_BUFFER = 1024 * 1024

// returns trimmed raw output (empty string when git produced none) — the
// display placeholder for empties belongs to the calling tool/display layer
export function runGitCommand(
  args: string[],
  cwd: string,
  options: GitCommandOptions = {}
): GitCommandResult
{
  const {
    timeout = DEFAULT_GIT_TIMEOUT,
    maxBuffer = DEFAULT_GIT_MAX_BUFFER,
    allowStdoutOnError = false,
  } = options

  try
  {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
      maxBuffer,
    })

    return { output: output.trimEnd() }
  }
  catch (err: unknown)
  {
    const execErr = err as {
      stdout?: string
      stderr?: string
      message?: string
    }

    if (allowStdoutOnError && execErr.stdout)
    {
      return { output: execErr.stdout.trimEnd() }
    }

    return {
      output: '',
      error: execErr.stderr?.trim() || execErr.message || 'git command failed',
    }
  }
}
