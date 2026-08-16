// src/inference/worker-supervisor.ts
// spawn, handshake, cancel recycling, restart-once, and joined worker disposal

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  formatWorkerInstallError,
  resolveInferenceConfig,
} from '../config/inference.js'
import {
  isEnvelope,
  isHandshakeFrame,
  type Envelope,
  type HandshakeResult,
} from '../protocol/index.js'
import { toError, toErrorMessage } from '../utils/errors.js'
import { raceAbort } from '../utils/abort.js'

const PROTOCOL_VERSION = 1
const REQUIRED_METHODS = ['chat.start', 'model.list', 'model.show'] as const
const MAX_LINE_BYTES = 16 * 1024 * 1024
const DEFAULT_CLOSE_DELAY_MS = 2_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000
const ABORT_RECYCLE_GRACE_MS = 250

export interface WorkerStdioTransport
{
  readonly pid?: number
  start(): Promise<void>
  write(line: string): Promise<void>
  onLine(handler: (line: string) => void): void
  onExit(
    handler: (code: number | null, signal: NodeJS.Signals | null) => void
  ): void
  onError(handler: (error: Error) => void): void
  close(): Promise<void>
}

export interface WorkerSupervisorOptions
{
  transportFactory?: () => WorkerStdioTransport
  closeDelayMs?: number
  handshakeTimeoutMs?: number
  repoRoot?: string
  extraEnv?: NodeJS.ProcessEnv
}

interface PendingRequest
{
  method: string
  pushEvent: (envelope: Envelope) => void
  finish: (envelope: Envelope) => void
  fail: (error: Error) => void
}

interface WorkerLease
{
  transport: WorkerStdioTransport
  release: () => void
}

interface WorkerRecovery
{
  transport: WorkerStdioTransport
  requestIds: Set<string>
  markHealthy: () => void
  promise: Promise<void>
}

interface SendRequestOptions
{
  transport?: WorkerStdioTransport
  recycleOnAbort?: boolean
}

function coralRepoRoot(): string
{
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..')
}

function backendProjectPath(repoRoot: string): string
{
  return resolve(repoRoot, 'packages/coral-backend')
}

export function resolveWorkerLaunch(
  repoRoot = coralRepoRoot(),
  extraEnv?: NodeJS.ProcessEnv
):
  | { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
  | { error: string }
  {
  const config = resolveInferenceConfig()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    ...extraEnv,
  }
  const python = nonemptyEnv(env.CORAL_PYTHON) ?? config.python
  const mlxModelsDir =
    nonemptyEnv(env.CORAL_MLX_MODELS_DIR) ?? config.mlxModelsDir
  if (mlxModelsDir) env.CORAL_MLX_MODELS_DIR = resolve(mlxModelsDir)
  const project = backendProjectPath(repoRoot)
  const cwd = repoRoot

  if (python)
  {
    env.PYTHONPATH = [resolve(project, 'src'), env.PYTHONPATH]
      .filter(Boolean)
      .join(':')
    return {
      command: python,
      args: ['-m', 'coral_backend'],
      cwd,
      env,
    }
  }

  if (!existsSync(resolve(project, 'pyproject.toml')))
  {
    return {
      error: formatWorkerInstallError(
        `packages/coral-backend is missing at ${project}.`
      ),
    }
  }

  return {
    command: 'uv',
    args: ['run', '--project', project, 'python', '-m', 'coral_backend'],
    cwd,
    env,
  }
}

function nonemptyEnv(value: string | undefined): string | undefined
{
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

class LineBuffer
{
  private chunks: Buffer[] = []
  private totalBytes = 0

  append(chunk: Buffer): string[]
  {
    if (chunk.length === 0) return []
    this.chunks.push(chunk)
    this.totalBytes += chunk.length
    if (this.totalBytes > MAX_LINE_BYTES)
    {
      throw new Error(
        `worker stdio line exceeds ${MAX_LINE_BYTES} byte protocol limit`
      )
    }

    const joined = Buffer.concat(this.chunks)
    const lines: string[] = []
    let start = 0
    for (let index = 0; index < joined.length; index++)
    {
      if (joined[index] !== 10) continue
      lines.push(
        joined.subarray(start, index).toString('utf8').replace(/\r$/, '')
      )
      start = index + 1
    }
    this.chunks = start < joined.length ? [joined.subarray(start)] : []
    this.totalBytes = this.chunks[0]?.length ?? 0
    return lines
  }

  clear(): void
  {
    this.chunks = []
    this.totalBytes = 0
  }
}

class ChildStdioTransport implements WorkerStdioTransport
{
  private child?: ChildProcessWithoutNullStreams
  private readonly buffer = new LineBuffer()
  private lineHandler?: (line: string) => void
  private exitHandler?: (
    code: number | null,
    signal: NodeJS.Signals | null
  ) => void
  private errorHandler?: (error: Error) => void
  private accepting = true
  private readonly closeDelayMs: number
  private readonly detached = process.platform !== 'win32'

  constructor(
    private readonly launch: {
      command: string
      args: string[]
      cwd: string
      env: NodeJS.ProcessEnv
    },
    closeDelayMs: number
  )
  {
    this.closeDelayMs = closeDelayMs
  }

  get pid(): number | undefined
  {
    return this.child?.pid
  }

  async start(): Promise<void>
  {
    if (this.child) throw new Error('worker stdio transport already started')
    await new Promise<void>((resolve, reject) =>
    {
      const child = spawn(this.launch.command, this.launch.args, {
        cwd: this.launch.cwd,
        env: this.launch.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // new process group so dispose can SIGTERM/SIGKILL uv + python together
        detached: this.detached,
      })
      this.child = child
      child.once('error', (error) =>
      {
        reject(error)
        this.errorHandler?.(toError(error))
      })
      child.once('spawn', resolve)
      child.once('close', (code, signal) =>
      {
        if (this.child === child) this.child = undefined
        this.exitHandler?.(code, signal)
      })
      child.stdin.on('error', (error) => this.errorHandler?.(toError(error)))
      child.stdout.on('data', (chunk: Buffer) =>
      {
        if (!this.accepting) return
        try
        {
          for (const line of this.buffer.append(chunk))
          {
            if (line.trim()) this.lineHandler?.(line)
          }
        }
        catch (error)
        {
          this.errorHandler?.(toError(error))
        }
      })
      child.stdout.on('error', (error) => this.errorHandler?.(toError(error)))
      // drain stderr so a pipe-backed worker cannot block on a full buffer
      child.stderr.resume()
    })
  }

  write(line: string): Promise<void>
  {
    return new Promise((resolve, reject) =>
    {
      const stdin = this.child?.stdin
      if (!stdin || stdin.destroyed || stdin.writableEnded)
      {
        reject(new Error('Python worker is not connected'))
        return
      }

      let settled = false
      const cleanup = (): void =>
      {
        stdin.removeListener('error', onError)
        stdin.removeListener('close', onClose)
      }
      const finish = (error?: Error | null): void =>
      {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(toError(error))
        else resolve()
      }
      const onError = (error: Error): void => finish(error)
      const onClose = (): void =>
        finish(
          new Error('Python worker stdin closed before the frame was sent')
        )

      stdin.once('error', onError)
      stdin.once('close', onClose)
      try
      {
        stdin.write(`${line}\n`, (error) => finish(error))
      }
      catch (error)
      {
        finish(toError(error))
      }
    })
  }

  onLine(handler: (line: string) => void): void
  {
    this.lineHandler = handler
  }

  onExit(
    handler: (code: number | null, signal: NodeJS.Signals | null) => void
  ): void
  {
    this.exitHandler = handler
  }

  onError(handler: (error: Error) => void): void
  {
    this.errorHandler = handler
  }

  async close(): Promise<void>
  {
    this.accepting = false
    this.buffer.clear()
    const child = this.child
    this.child = undefined
    if (!child) return

    const closed = new Promise<void>((resolve) => child.once('close', resolve))
    try
    {
      child.stdin.end()
    }
    catch
    {
      // ignore a close race when stdin is already closed
    }

    await Promise.race([closed, delay(this.closeDelayMs)])
    if (stillRunning(child))
    {
      signalProcessTree(child, 'SIGTERM', this.detached)
      await Promise.race([closed, delay(this.closeDelayMs)])
    }
    if (stillRunning(child))
    {
      signalProcessTree(child, 'SIGKILL', this.detached)
      await Promise.race([closed, delay(this.closeDelayMs)])
    }
  }
}

function delay(ms: number): Promise<void>
{
  return new Promise((resolve) => setTimeout(resolve, ms).unref())
}

function stillRunning(child: ChildProcessWithoutNullStreams): boolean
{
  return child.exitCode === null && child.signalCode === null
}

function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  grouped: boolean
): void
{
  if (grouped && child.pid)
  {
    try
    {
      process.kill(-child.pid, signal)
      return
    }
    catch
    {
      // fall through to the direct pid when the group is already gone
    }
  }
  try
  {
    child.kill(signal)
  }
  catch
  {
    // ignore a close race between the check and signal
  }
}

function isHandshakeResult(
  payload: Record<string, unknown>
): payload is HandshakeResult
{
  if (!isHandshakeFrame(payload)) return false
  if (!('methods' in payload) || !Array.isArray(payload.methods)) return false
  if (
    !('versions' in payload) ||
    typeof payload.versions !== 'object' ||
    payload.versions === null
  )
  {
    return false
  }
  return true
}

function missingMethods(methods: string[]): string[]
{
  const advertised = new Set(methods)
  return REQUIRED_METHODS.filter((method) => !advertised.has(method))
}

function envelopeErrorMessage(envelope: Envelope): string
{
  if (envelope.kind !== 'error') return 'worker returned an error frame'
  const message = envelope.payload.message
  if (typeof message === 'string' && message) return message
  return 'worker request failed'
}

/**
 * Owns the Python inference worker process for the application runtime.
 */
export class WorkerSupervisor
{
  private transport?: WorkerStdioTransport
  private readonly pending = new Map<string, PendingRequest>()
  private ready: Promise<void> | undefined
  private restartUsed = false
  private disposing = false
  private deadError?: Error
  private handshake?: HandshakeResult
  private readonly lifecycleAbort = new AbortController()
  private readonly transportCloses = new WeakMap<
    WorkerStdioTransport,
    Promise<void>
  >()
  private readonly transportUseCounts = new WeakMap<
    WorkerStdioTransport,
    number
  >()
  private readonly transportIdleWaiters = new WeakMap<
    WorkerStdioTransport,
    Set<() => void>
  >()
  private recovery?: WorkerRecovery
  private disposePromise?: Promise<void>
  private readonly options: WorkerSupervisorOptions
  private readonly repoRoot: string

  constructor(options: WorkerSupervisorOptions = {})
  {
    this.options = options
    this.repoRoot = options.repoRoot ?? coralRepoRoot()
  }

  isLaunchable(): boolean
  {
    if (this.options.transportFactory) return true
    return !(
      'error' in resolveWorkerLaunch(this.repoRoot, this.options.extraEnv)
    )
  }

  launchErrorMessage(): string
  {
    const launch = resolveWorkerLaunch(this.repoRoot, this.options.extraEnv)
    return 'error' in launch ? launch.error : formatWorkerInstallError()
  }

  pid(): number | undefined
  {
    return this.transport?.pid
  }

  handshakeResult(): HandshakeResult | undefined
  {
    return this.handshake
  }

  async writeRaw(line: string): Promise<void>
  {
    const lease = await this.acquireTransport()
    try
    {
      await lease.transport.write(line)
    }
    finally
    {
      lease.release()
    }
  }

  async ensure(signal?: AbortSignal): Promise<void>
  {
    signal?.throwIfAborted()
    if (this.deadError) throw this.deadError
    if (this.disposing) throw new Error('Python worker is shutting down')
    const ready = this.ready ?? this.beginStartup(false)
    await raceAbort(ready, signal)
  }

  async request(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>>
  {
    const lease = await this.acquireTransport(signal)
    try
    {
      const envelope = await this.sendRequest(method, payload, signal, {
        transport: lease.transport,
        recycleOnAbort: true,
      })
      if (envelope.kind === 'error')
      {
        throw new Error(envelopeErrorMessage(envelope))
      }
      if (envelope.kind !== 'result')
      {
        throw new Error(`worker ${method} did not return a result frame`)
      }
      return envelope.payload
    }
    finally
    {
      lease.release()
    }
  }

  async *stream(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): AsyncGenerator<Envelope>
  {
    const lease = await this.acquireTransport(signal)
    const transport = lease.transport
    const events: Envelope[] = []
    let notify: (() => void) | undefined
    let finished: Envelope | undefined
    let failed: Error | undefined
    let requestStarted = false
    let requestMayBeActive = false
    let cancelSent = false
    let recoveryScheduled = false
    const wait = (): Promise<void> =>
      new Promise((resolve) =>
      {
        notify = resolve
      })

    const id = randomUUID()
    const pending: PendingRequest = {
      method,
      pushEvent: (envelope) =>
      {
        events.push(envelope)
        notify?.()
      },
      finish: (envelope) =>
      {
        finished = envelope
        notify?.()
      },
      fail: (error) =>
      {
        failed = error
        notify?.()
      },
    }
    this.pending.set(id, pending)

    const onAbort = (): void =>
    {
      if (finished || failed) return
      recoverAfterCancel()
      cancel()
      pending.fail(new DOMException('Aborted', 'AbortError'))
    }
    const cancel = (): void =>
    {
      if (cancelSent) return
      cancelSent = true
      void this.writeFrame({ v: 1, id, kind: 'cancel' }, transport).catch(
        () => undefined
      )
    }
    const recoverAfterCancel = (): void =>
    {
      if (!requestMayBeActive || recoveryScheduled) return
      recoveryScheduled = true
      lease.release()
      this.scheduleRecoveryAfterAbort(transport, id)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try
    {
      if (signal?.aborted)
      {
        onAbort()
      }
      else
      {
        requestMayBeActive = true
        const requestWrite = this.writeFrame(
          {
            v: 1,
            id,
            kind: 'request',
            method,
            payload,
          },
          transport
        )
        // the abort race may win while stdio is backpressured; retain a
        // rejection consumer for the underlying write's later settlement
        void requestWrite.catch(() => undefined)
        await raceAbort(requestWrite, signal)
        requestStarted = true
      }

      while (!finished && !failed)
      {
        if (events.length === 0) await wait()
        while (events.length > 0)
        {
          yield events.shift()!
        }
      }
      while (events.length > 0)
      {
        yield events.shift()!
      }
      if (failed) throw failed
      if (finished) yield finished
    }
    finally
    {
      signal?.removeEventListener('abort', onAbort)
      this.pending.delete(id)
      if (requestStarted && !finished && !failed)
      {
        recoverAfterCancel()
        cancel()
      }
      lease.release()
    }
  }

  dispose(): Promise<void>
  {
    if (!this.disposePromise)
    {
      this.disposing = true
      this.lifecycleAbort.abort()
      this.disposePromise = this.disposeInternal()
    }
    return this.disposePromise
  }

  private async disposeInternal(): Promise<void>
  {
    const ready = this.ready
    this.ready = undefined
    this.failPending(new Error('Python worker shut down'))
    const transport = this.transport
    this.transport = undefined
    const close = transport ? this.closeTransport(transport) : undefined
    await ready?.catch(() => undefined)
    await close
  }

  private beginStartup(fatalOnFailure: boolean): Promise<void>
  {
    const startup = Promise.resolve().then(() =>
      this.startAndHandshake(this.lifecycleAbort.signal)
    )
    this.ready = startup
    void startup.catch((error) =>
    {
      if (this.ready !== startup) return
      this.ready = undefined
      if (fatalOnFailure && !this.disposing) this.deadError = toError(error)
    })
    return startup
  }

  // block new work behind a stable transport generation while allowing
  // already-admitted unrelated requests to drain before a recycle
  private async acquireTransport(signal?: AbortSignal): Promise<WorkerLease>
  {
    while (true)
    {
      signal?.throwIfAborted()
      if (this.deadError) throw this.deadError
      if (this.disposing) throw new Error('Python worker is shutting down')
      const ready = this.ready ?? this.beginStartup(false)
      await raceAbort(ready, signal)
      if (this.ready !== ready) continue

      const transport = this.transport
      if (!transport) continue
      const count = this.transportUseCounts.get(transport) ?? 0
      this.transportUseCounts.set(transport, count + 1)
      let released = false
      return {
        transport,
        release: () =>
        {
          if (released) return
          released = true
          this.releaseTransport(transport)
        },
      }
    }
  }

  private releaseTransport(transport: WorkerStdioTransport): void
  {
    const count = this.transportUseCounts.get(transport) ?? 0
    if (count > 1)
    {
      this.transportUseCounts.set(transport, count - 1)
      return
    }
    this.transportUseCounts.delete(transport)
    const waiters = this.transportIdleWaiters.get(transport)
    this.transportIdleWaiters.delete(transport)
    for (const resolveIdle of waiters ?? []) resolveIdle()
  }

  private waitForTransportIdle(transport: WorkerStdioTransport): Promise<void>
  {
    if (!this.transportUseCounts.has(transport)) return Promise.resolve()
    return new Promise((resolveIdle) =>
    {
      const waiters = this.transportIdleWaiters.get(transport) ?? new Set()
      waiters.add(resolveIdle)
      this.transportIdleWaiters.set(transport, waiters)
    })
  }

  private abandonTransportUses(transport: WorkerStdioTransport): void
  {
    this.transportUseCounts.delete(transport)
    const waiters = this.transportIdleWaiters.get(transport)
    this.transportIdleWaiters.delete(transport)
    for (const resolveIdle of waiters ?? []) resolveIdle()
  }

  // opaque Python calls cannot always observe cancel until native work returns;
  // recycle only after cooperative cancel gets a short chance to settle
  private scheduleRecoveryAfterAbort(
    transport: WorkerStdioTransport,
    requestId: string
  ): void
  {
    if (this.disposing || this.transport !== transport) return
    if (
      this.recovery?.transport === transport &&
      this.recovery.requestIds.size > 0
    )
    {
      this.recovery.requestIds.add(requestId)
      return
    }

    const requestIds = new Set([requestId])
    let markHealthy!: () => void
    const healthy = new Promise<void>((resolveHealthy) =>
    {
      markHealthy = resolveHealthy
    })
    const promise = Promise.resolve().then(() =>
      this.recoverAfterAbort(transport, requestIds, healthy)
    )
    const recovery = {
      transport,
      requestIds,
      markHealthy,
      promise,
    }
    this.recovery = recovery
    this.ready = promise
    void promise.then(
      () =>
      {
        if (this.recovery === recovery) this.recovery = undefined
      },
      () =>
      {
        if (this.recovery === recovery) this.recovery = undefined
        if (this.ready === promise) this.ready = undefined
      }
    )
  }

  private acknowledgeRecovery(
    transport: WorkerStdioTransport,
    requestId: string
  ): void
  {
    const recovery = this.recovery
    if (recovery?.transport !== transport) return
    if (!recovery.requestIds.delete(requestId)) return
    if (recovery.requestIds.size === 0) recovery.markHealthy()
  }

  private async recoverAfterAbort(
    transport: WorkerStdioTransport,
    requestIds: Set<string>,
    healthy: Promise<void>
  ): Promise<void>
  {
    let graceTimer: NodeJS.Timeout | undefined
    try
    {
      await raceAbort(
        Promise.race([
          healthy,
          new Promise<void>((resolveGrace) =>
          {
            graceTimer = setTimeout(resolveGrace, ABORT_RECYCLE_GRACE_MS)
          }),
        ]),
        this.lifecycleAbort.signal
      )
      if (requestIds.size === 0) return
      if (this.transport !== transport) return
      await raceAbort(
        this.waitForTransportIdle(transport),
        this.lifecycleAbort.signal
      )
    }
    catch (error)
    {
      if (this.disposing) return
      throw error
    }
    finally
    {
      if (graceTimer) clearTimeout(graceTimer)
    }
    if (
      this.disposing ||
      this.transport !== transport ||
      requestIds.size === 0
    )
    {
      return
    }

    this.transport = undefined
    this.handshake = undefined
    try
    {
      await this.closeTransport(transport)
    }
    catch (error)
    {
      this.deadError = new Error(
        `Python worker could not be recycled safely: ${toErrorMessage(error)}`
      )
      throw this.deadError
    }
    if (this.disposing) return
    await this.startAndHandshake(this.lifecycleAbort.signal)
  }

  private async startAndHandshake(signal: AbortSignal): Promise<void>
  {
    signal.throwIfAborted()
    const transport = this.createTransport()
    this.transport = transport
    transport.onLine((line) => this.handleLine(transport, line))
    transport.onError((error) => this.handleTransportError(transport, error))
    transport.onExit((code, sig) => this.handleExit(transport, code, sig))
    let started = false
    try
    {
      await raceAbort(transport.start(), signal)
      started = true
      signal.throwIfAborted()
      await this.handshakeWith(signal)
    }
    catch (error)
    {
      if (this.transport === transport)
      {
        this.transport = undefined
        this.handshake = undefined
      }
      let failure = toError(error)
      if (!started)
      {
        const detail = toErrorMessage(error)
        failure = new Error(
          formatWorkerInstallError(
            `Failed to spawn the worker (${detail}). Check CORAL_PYTHON and that uv is on PATH.`
          )
        )
      }
      try
      {
        await this.closeTransport(transport)
      }
      catch (closeError)
      {
        throw new AggregateError(
          [failure, toError(closeError)],
          `${failure.message} Worker cleanup also failed: ${toErrorMessage(closeError)}`
        )
      }
      throw failure
    }
  }

  private closeTransport(transport: WorkerStdioTransport): Promise<void>
  {
    const existing = this.transportCloses.get(transport)
    if (existing) return existing
    const closing = Promise.resolve().then(() => transport.close())
    this.transportCloses.set(transport, closing)
    return closing
  }

  private createTransport(): WorkerStdioTransport
  {
    if (this.options.transportFactory) return this.options.transportFactory()
    const launch = resolveWorkerLaunch(this.repoRoot, this.options.extraEnv)
    if ('error' in launch) throw new Error(launch.error)
    return new ChildStdioTransport(
      launch,
      this.options.closeDelayMs ?? DEFAULT_CLOSE_DELAY_MS
    )
  }

  private async handshakeWith(signal?: AbortSignal): Promise<void>
  {
    const timeoutMs =
      this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let envelope: Envelope
    try
    {
      envelope = await this.sendRequest(
        'handshake',
        { protocolVersion: PROTOCOL_VERSION, client: 'coral' },
        combined
      )
    }
    catch (error)
    {
      throw new Error(
        `Python worker handshake failed: ${toErrorMessage(error)}. ` +
          'Do not fall back to Ollama for an mlx: model.'
      )
    }

    if (envelope.kind !== 'result')
    {
      throw new Error(
        `Python worker handshake failed: ${
          envelope.kind === 'error'
            ? envelopeErrorMessage(envelope)
            : `unexpected ${envelope.kind} frame`
        }`
      )
    }

    if (!isHandshakeResult(envelope.payload))
    {
      throw new Error(
        'Python worker handshake failed: result was not a handshake payload. ' +
          'Refuse to speak Ollama dialect over a guessed schema.'
      )
    }

    const result = envelope.payload
    if (result.protocolVersion !== PROTOCOL_VERSION)
    {
      throw new Error(
        `Python worker protocolVersion ${result.protocolVersion} is unsupported; Coral expects ${PROTOCOL_VERSION}.`
      )
    }
    const missing = missingMethods(result.methods)
    if (missing.length > 0)
    {
      throw new Error(
        `Python worker is missing required methods: ${missing.join(', ')}.`
      )
    }
    this.handshake = result
  }

  private sendRequest(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    options: SendRequestOptions = {}
  ): Promise<Envelope>
  {
    const id = randomUUID()
    const transport = options.transport ?? this.transport
    let requestStarted = false
    return new Promise((resolve, reject) =>
    {
      const onAbort = (): void =>
      {
        this.pending.delete(id)
        if (requestStarted && options.recycleOnAbort && transport)
        {
          this.scheduleRecoveryAfterAbort(transport, id)
        }
        void this.writeFrame({ v: 1, id, kind: 'cancel' }, transport).catch(
          () => undefined
        )
        reject(new DOMException('Aborted', 'AbortError'))
      }
      if (signal?.aborted)
      {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        method,
        pushEvent: () =>
        {},
        finish: (envelope) =>
        {
          signal?.removeEventListener('abort', onAbort)
          this.pending.delete(id)
          resolve(envelope)
        },
        fail: (error) =>
        {
          signal?.removeEventListener('abort', onAbort)
          this.pending.delete(id)
          reject(error)
        },
      })
      requestStarted = true
      void this.writeFrame(
        {
          v: 1,
          id,
          kind: 'request',
          method,
          payload,
        },
        transport
      ).catch((error) =>
      {
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        reject(toError(error))
      })
    })
  }

  private async writeFrame(
    frame: Omit<Envelope, 'payload'> & { payload?: Record<string, unknown> },
    transport = this.transport
  ): Promise<void>
  {
    if (!transport) throw new Error('Python worker is not connected')
    await transport.write(JSON.stringify(frame))
  }

  private handleLine(transport: WorkerStdioTransport, line: string): void
  {
    if (this.transport !== transport) return
    let parsed: unknown
    try
    {
      parsed = JSON.parse(line)
    }
    catch
    {
      this.failOldest(
        new Error('Python worker sent a malformed JSON line; request aborted')
      )
      return
    }
    if (!isEnvelope(parsed))
    {
      this.failOldest(
        new Error('Python worker sent a frame that failed envelope validation')
      )
      return
    }
    if (parsed.kind !== 'event')
    {
      this.acknowledgeRecovery(transport, parsed.id)
    }
    const pending = this.pending.get(parsed.id)
    if (!pending) return
    if (parsed.kind === 'event') pending.pushEvent(parsed)
    else pending.finish(parsed)
  }

  private handleTransportError(
    transport: WorkerStdioTransport,
    error: Error
  ): void
  {
    if (this.transport !== transport) return
    this.failPending(error)
  }

  private handleExit(
    transport: WorkerStdioTransport,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void
  {
    if (this.disposing || this.transport !== transport) return
    const crash = new Error(
      `Python worker exited (code ${String(code)}, signal ${String(signal)}). ` +
        'The in-flight chat request was aborted.'
    )
    this.failPending(crash)
    this.abandonTransportUses(transport)
    this.transport = undefined
    this.ready = undefined
    this.handshake = undefined
    if (this.restartUsed)
    {
      this.deadError = new Error(
        formatWorkerInstallError(
          'Python worker crashed again after one restart; not retrying forever.'
        )
      )
      return
    }
    this.restartUsed = true
    this.beginStartup(true)
  }

  private failPending(error: Error): void
  {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const request of pending) request.fail(error)
  }

  private failOldest(error: Error): void
  {
    const first = this.pending.values().next().value
    if (first) first.fail(error)
  }
}
