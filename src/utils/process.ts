// src/utils/process.ts
// shared child-process execution limits

import { exec, execFile } from 'node:child_process'
import { toErrorMessage } from './errors.js'

// default stdout/stderr buffer cap for spawned processes (1 MB)
export const DEFAULT_CHILD_PROCESS_MAX_BUFFER = 1024 * 1024

export interface ChildProcessOptions
{
  cwd?: string
  timeout?: number
  maxBuffer?: number
  // abort kills the child (SIGTERM); spread into the exec/execFile options
  signal?: AbortSignal
}

export interface ChildProcessSuccess
{
  ok: true
  stdout: string
  stderr: string
}

export interface ChildProcessFailure
{
  ok: false
  stdout: string
  stderr: string
  message: string
  code?: string | number
  signal?: NodeJS.Signals | string | null
}

export type ChildProcessResult = ChildProcessSuccess | ChildProcessFailure

export interface FormatProcessErrorOptions
{
  includeStdout?: boolean
  fallback?: string
}

function outputToString(value: unknown): string
{
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf-8')
  return ''
}

function processFailure(
  err: unknown,
  stdout?: unknown,
  stderr?: unknown
): ChildProcessFailure
{
  const processErr = err as NodeJS.ErrnoException & {
    stdout?: unknown
    stderr?: unknown
    signal?: NodeJS.Signals | string | null
  }

  return {
    ok: false,
    stdout: outputToString(stdout) || outputToString(processErr.stdout),
    stderr: outputToString(stderr) || outputToString(processErr.stderr),
    message: toErrorMessage(err),
    code: processErr.code,
    signal: processErr.signal,
  }
}

export function formatProcessError(
  failure: ChildProcessFailure,
  options: FormatProcessErrorOptions = {}
): string
{
  const parts = [
    options.includeStdout ? failure.stdout.trim() : '',
    failure.stderr.trim(),
  ].filter(Boolean)
  return parts.join('\n') || failure.message || options.fallback || 'failed'
}

export function execShellCommand(
  command: string,
  options: ChildProcessOptions = {}
): Promise<ChildProcessResult>
{
  return new Promise((resolve) =>
  {
    exec(command, { ...options, encoding: 'utf-8' }, (err, stdout, stderr) =>
    {
      if (err)
      {
        resolve(processFailure(err, stdout, stderr))
        return
      }

      resolve({ ok: true, stdout, stderr })
    })
  })
}

export function execFileCommand(
  file: string,
  args: string[],
  options: ChildProcessOptions = {}
): Promise<ChildProcessResult>
{
  return new Promise((resolve) =>
  {
    execFile(
      file,
      args,
      { ...options, encoding: 'utf-8' },
      (err, stdout, stderr) =>
      {
        if (err)
        {
          resolve(processFailure(err, stdout, stderr))
          return
        }

        resolve({ ok: true, stdout, stderr })
      }
    )
  })
}
