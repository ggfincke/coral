// src/utils/process.ts
// shared child-process execution limits, env, & the process-group runner

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { toErrorMessage } from './errors.js'

// default stdout/stderr buffer cap for spawned processes (1 MB)
export const DEFAULT_CHILD_PROCESS_MAX_BUFFER = 1024 * 1024

// hosted provider credentials only coral's own clients use; model-directed
// children never need them, so they are dropped from every child env
const HOSTED_CREDENTIAL_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
]

// time a stopped group gets between SIGTERM & SIGKILL
const STOP_GRACE_MS = 1000

// time output may keep arriving after the leader exits; a background job that
// still holds the pipes keeps running, & its later output is discarded
const OUTPUT_DRAIN_MS = 200

// most chars of a stream's head kept once output passes its cap
const OUTPUT_HEAD_CHARS = 64 * 1024

export interface ChildProcessOptions
{
  cwd?: string
  timeout?: number
  maxBuffer?: number
  // abort kills the child (SIGTERM); spread into the execFile options
  signal?: AbortSignal
  // defaults to childProcessEnv()
  env?: NodeJS.ProcessEnv
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

export interface ProcessGroupOptions
{
  cwd?: string
  // ms before coral stops the whole group; omitted means no limit
  timeout?: number
  // abort stops the whole group
  signal?: AbortSignal
  // chars of each stream kept in memory, split between head & tail
  maxOutput?: number
  // defaults to childProcessEnv()
  env?: NodeJS.ProcessEnv
}

export interface ProcessGroupResult
{
  stdout: string
  stderr: string
  // null when a signal ended the leader or it never started
  exitCode: number | null
  signal: NodeJS.Signals | null
  // set when coral stopped the group itself
  stopped?: 'timeout' | 'abort'
  // set when the process could not start
  launchError?: string
}

// the current env minus hosted provider credentials, plus any overrides
export function childProcessEnv(
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv
{
  const env = { ...process.env, ...overrides }
  for (const name of HOSTED_CREDENTIAL_ENV) delete env[name]
  return env
}

/**
 * Keeps the first and last characters of process output within `limit`, so a
 * long run keeps going and both its opening lines and its end survive. Text
 * between them is replaced by a marker line naming how much was dropped.
 */
export class BoundedOutput
{
  private head = ''
  private tail = ''
  private headOpen = true
  private omitted = 0
  private readonly headLimit: number
  private readonly tailLimit: number

  constructor(limit = DEFAULT_CHILD_PROCESS_MAX_BUFFER)
  {
    this.headLimit = Math.min(OUTPUT_HEAD_CHARS, Math.floor(limit / 4))
    this.tailLimit = limit - this.headLimit
  }

  append(text: string): void
  {
    if (this.headOpen)
    {
      let room = this.headLimit - this.head.length
      if (text.length <= room)
      {
        this.head += text
        return
      }
      // keep a surrogate pair together on the tail side of the cut
      if (room > 0 && /[\uD800-\uDBFF]/.test(text[room - 1]!)) room--
      this.head += text.slice(0, room)
      text = text.slice(room)
      this.headOpen = false
    }
    this.tail += text
    if (this.tail.length > this.tailLimit)
    {
      let drop = this.tail.length - this.tailLimit
      if (/[\uDC00-\uDFFF]/.test(this.tail[drop]!)) drop++
      this.omitted += drop
      this.tail = this.tail.slice(drop)
    }
  }

  // decode a byte stream into this buffer; the returned flush appends a
  // multibyte character split across the final read
  capture(stream: Readable): () => void
  {
    const decoder = new StringDecoder('utf8')
    stream.on('data', (chunk: Buffer) => this.append(decoder.write(chunk)))
    return () => this.append(decoder.end())
  }

  toString(): string
  {
    if (!this.omitted) return this.head + this.tail
    const head = this.head.endsWith('\n') ? this.head : `${this.head}\n`
    return `${head}[${this.omitted} chars of output omitted]\n${this.tail}`
  }
}

// wait for the output pipes to close, but not for a background descendant
// that keeps them open after the leader exited: its later output is read &
// dropped (closing the pipes would SIGPIPE it) w/o keeping coral alive
export async function drainChildOutput(
  streams: Readable[],
  drainMs = OUTPUT_DRAIN_MS
): Promise<void>
{
  let timer: ReturnType<typeof setTimeout> | undefined
  const closed = streams.map((stream) =>
    stream.closed
      ? Promise.resolve()
      : new Promise<void>((resolve) => stream.once('close', () => resolve()))
  )
  await Promise.race([
    Promise.all(closed),
    new Promise<void>((resolve) =>
    {
      timer = setTimeout(resolve, drainMs)
    }),
  ])
  clearTimeout(timer)
  for (const stream of streams)
  {
    const pipe = stream as Readable & { unref?: () => void }
    if (pipe.closed) continue
    pipe.removeAllListeners('data')
    pipe.on('data', () =>
    {})
    pipe.unref?.()
  }
}

// signal every member of a process group; false once the group is empty
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean
{
  try
  {
    process.kill(-pgid, signal)
    return true
  }
  catch (err)
  {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

// the leader's exit, or the spawn error that replaced it
function waitForExit(
  child: ChildProcess
): Promise<
  { code: number | null; signal: NodeJS.Signals | null } | { error: Error }
>
{
  return new Promise((resolve) =>
  {
    child.once('error', (error) => resolve({ error }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

// SIGTERM the group, then SIGKILL whatever is left after the grace period.
// a pgid is never reused while any member is alive, so polling it is safe
async function stopGroup(pgid: number): Promise<void>
{
  if (!signalGroup(pgid, 'SIGTERM')) return
  const until = Date.now() + STOP_GRACE_MS
  while (Date.now() < until)
  {
    await new Promise((resolve) => setTimeout(resolve, 25))
    if (!signalGroup(pgid, 0)) return
  }
  signalGroup(pgid, 'SIGKILL')
}

// run a model-directed command in its own session & process group w/ no
// stdin & no terminal; a timeout or abort stops the whole group, & output
// past maxOutput keeps its head & tail instead of killing the run
export async function runProcessGroup(
  file: string,
  args: string[],
  options: ProcessGroupOptions = {}
): Promise<ProcessGroupResult>
{
  const stdout = new BoundedOutput(options.maxOutput)
  const stderr = new BoundedOutput(options.maxOutput)
  const result = (
    fields: Omit<ProcessGroupResult, 'stdout' | 'stderr'>
  ): ProcessGroupResult => ({
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    ...fields,
  })
  if (options.signal?.aborted)
  {
    return result({ exitCode: null, signal: null, stopped: 'abort' })
  }

  let child: ChildProcess
  try
  {
    // detached = setsid, so prompts that open /dev/tty fail instead of
    // drawing over the TUI, and the leader pid doubles as the group id
    child = spawn(file, args, {
      cwd: options.cwd,
      detached: true,
      env: options.env ?? childProcessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  catch (err)
  {
    return result({
      exitCode: null,
      signal: null,
      launchError: toErrorMessage(err),
    })
  }
  const flushes = [stdout.capture(child.stdout!), stderr.capture(child.stderr!)]

  let stopped: ProcessGroupResult['stopped']
  let stopping: Promise<void> | undefined
  const stop = (reason: 'timeout' | 'abort') =>
  {
    if (stopped || child.pid === undefined) return
    stopped = reason
    stopping = stopGroup(child.pid)
  }
  const onAbort = () => stop('abort')
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer =
    options.timeout === undefined
      ? undefined
      : setTimeout(() => stop('timeout'), options.timeout)

  const exit = await waitForExit(child)
  // a late abort or timer must not stop background jobs of a finished command
  clearTimeout(timer)
  options.signal?.removeEventListener('abort', onAbort)
  await stopping
  await drainChildOutput([child.stdout!, child.stderr!])
  for (const flush of flushes) flush()
  if ('error' in exit)
  {
    return result({
      exitCode: null,
      signal: null,
      launchError: toErrorMessage(exit.error),
    })
  }
  return result({ exitCode: exit.code, signal: exit.signal, stopped })
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
      { ...options, env: options.env ?? childProcessEnv(), encoding: 'utf-8' },
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
