// tests/helpers/child-race.ts
// deterministic IPC barriers for cross-process persistence tests

import { fork, type ChildProcess } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_CAPTURE_CHARS = 64 * 1024

export interface RaceWorkerSpec
{
  id: string
  payload: unknown
}

export interface RaceWorkerOptions
{
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

interface WorkerEnvelope
{
  type: string
  data?: unknown
}

interface MessageWaiter
{
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

function isWorkerEnvelope(value: unknown): value is WorkerEnvelope
{
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

function appendCapture(current: string, chunk: unknown): string
{
  const next = current + String(chunk)
  return next.length <= MAX_CAPTURE_CHARS
    ? next
    : next.slice(next.length - MAX_CAPTURE_CHARS)
}

export class RaceWorker
{
  private readonly child: ChildProcess
  private readonly timeoutMs: number
  private readonly queued = new Map<string, unknown[]>()
  private readonly waiters = new Map<string, MessageWaiter[]>()
  private readonly exitPromise: Promise<void>
  private exited = false
  private stopTimer: NodeJS.Timeout | undefined
  private stdout = ''
  private stderr = ''

  constructor(
    readonly id: string,
    fixturePath: string,
    payload: unknown,
    options: RaceWorkerOptions = {}
  )
  {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.child = fork(fixturePath, [JSON.stringify({ id, payload })], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })

    this.child.stdout?.on('data', (chunk) =>
    {
      this.stdout = appendCapture(this.stdout, chunk)
    })
    this.child.stderr?.on('data', (chunk) =>
    {
      this.stderr = appendCapture(this.stderr, chunk)
    })
    this.child.on('message', (message) => this.receive(message))

    this.exitPromise = new Promise<void>((resolve, reject) =>
    {
      this.child.once('error', (error) =>
      {
        this.rejectWaiters(error)
        reject(error)
      })
      this.child.once('exit', (code, signal) =>
      {
        this.exited = true
        if (this.stopTimer) clearTimeout(this.stopTimer)
        const detail = this.outputDetail()
        if (code === 0)
        {
          this.rejectWaiters(
            new Error(
              `Race worker ${this.id} exited before its awaited message`
            )
          )
          resolve()
          return
        }

        const error = new Error(
          `Race worker ${this.id} failed (code ${String(code)}, signal ${String(signal)})${detail}`
        )
        this.rejectWaiters(error)
        reject(error)
      })
    })
  }

  private outputDetail(): string
  {
    const parts = [this.stdout.trim(), this.stderr.trim()].filter(Boolean)
    return parts.length > 0 ? `\n${parts.join('\n')}` : ''
  }

  private receive(message: unknown): void
  {
    if (!isWorkerEnvelope(message)) return

    const waiters = this.waiters.get(message.type)
    const waiter = waiters?.shift()
    if (waiter)
    {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(message.data)
      if (waiters?.length === 0) this.waiters.delete(message.type)
      return
    }

    const queue = this.queued.get(message.type) ?? []
    queue.push(message.data)
    this.queued.set(message.type, queue)
  }

  private rejectWaiters(error: Error): void
  {
    for (const waiters of this.waiters.values())
    {
      for (const waiter of waiters)
      {
        if (waiter.timer) clearTimeout(waiter.timer)
        waiter.reject(error)
      }
    }
    this.waiters.clear()
  }

  waitFor(type: string): Promise<unknown>
  {
    const queue = this.queued.get(type)
    if (queue && queue.length > 0)
    {
      const value = queue.shift()
      if (queue.length === 0) this.queued.delete(type)
      return Promise.resolve(value)
    }

    if (this.exited)
    {
      return Promise.reject(
        new Error(
          `Race worker ${this.id} already exited while awaiting ${type}`
        )
      )
    }

    return new Promise((resolve, reject) =>
    {
      const waiter: MessageWaiter = { resolve, reject }
      const timer = setTimeout(() =>
      {
        const waiters = this.waiters.get(type)
        const index = waiters?.indexOf(waiter) ?? -1
        if (waiters && index >= 0) waiters.splice(index, 1)
        if (waiters?.length === 0) this.waiters.delete(type)

        const detail = this.outputDetail()
        reject(
          new Error(
            `Timed out awaiting ${type} from race worker ${this.id}${detail}`
          )
        )
      }, this.timeoutMs)
      const waiters = this.waiters.get(type) ?? []
      waiter.timer = timer
      waiters.push(waiter)
      this.waiters.set(type, waiters)
    })
  }

  send(type: string, data?: unknown): void
  {
    if (!this.child.connected)
    {
      throw new Error(`Race worker ${this.id} IPC channel is closed`)
    }
    this.child.send({ type, data })
  }

  waitForExit(): Promise<void>
  {
    return this.exitPromise
  }

  stop(): void
  {
    if (this.exited || this.stopTimer) return
    this.child.kill('SIGTERM')
    this.stopTimer = setTimeout(() =>
    {
      if (!this.exited) this.child.kill('SIGKILL')
    }, 1_000)
    this.stopTimer.unref()
  }
}

export async function startRaceWorkers(
  fixturePath: string,
  specs: RaceWorkerSpec[],
  options: RaceWorkerOptions = {}
): Promise<RaceWorker[]>
{
  const workers = specs.map(
    (spec) => new RaceWorker(spec.id, fixturePath, spec.payload, options)
  )

  try
  {
    await Promise.all(workers.map((worker) => worker.waitFor('ready')))
    return workers
  }
  catch (error)
  {
    workers.forEach((worker) => worker.stop())
    await Promise.allSettled(workers.map((worker) => worker.waitForExit()))
    throw error
  }
}

export async function finishRaceWorkers(
  workers: RaceWorker[]
): Promise<unknown[]>
{
  try
  {
    const results = await Promise.all(
      workers.map((worker) => worker.waitFor('done'))
    )
    await Promise.all(workers.map((worker) => worker.waitForExit()))
    return results
  }
  finally
  {
    workers.forEach((worker) => worker.stop())
    await Promise.allSettled(workers.map((worker) => worker.waitForExit()))
  }
}

export async function stopRaceWorkers(workers: RaceWorker[]): Promise<void>
{
  workers.forEach((worker) => worker.stop())
  await Promise.allSettled(workers.map((worker) => worker.waitForExit()))
}

export async function runBarrierRace(
  fixturePath: string,
  specs: RaceWorkerSpec[],
  options: RaceWorkerOptions = {}
): Promise<unknown[]>
{
  const workers = await startRaceWorkers(fixturePath, specs, options)
  workers.forEach((worker) => worker.send('go'))
  return finishRaceWorkers(workers)
}
