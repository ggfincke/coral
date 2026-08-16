// tests/scripts/mlx-benchmark/process.ts
// owned-child lifecycle, process-tree containment, and 100 ms RSS evidence

import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ProcessLaunchConfig } from './types.js'

const execFileAsync = promisify(execFile)
const TAIL_BYTES = 16 * 1024

interface ProcessRow
{
  pid: number
  ppid: number
  pgid: number
  rssBytes: number
}

export interface RssSample
{
  elapsedMs: number
  rssBytes: number
  pids: number[]
}

function appendTail(current: string, chunk: Buffer): string
{
  const combined = current + chunk.toString('utf8')
  return combined.length <= TAIL_BYTES ? combined : combined.slice(-TAIL_BYTES)
}

function validPid(pid: number): boolean
{
  return Number.isInteger(pid) && pid > 1
}

export async function processTable(): Promise<ProcessRow[]>
{
  const { stdout } = await execFileAsync('ps', [
    '-axo',
    'pid=,ppid=,pgid=,rss=',
  ])
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n'))
  {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
    })
  }
  return rows
}

function processGroupPids(rows: ProcessRow[], pgid: number): number[]
{
  return rows
    .filter((row) => row.pgid === pgid)
    .map((row) => row.pid)
    .sort((left, right) => left - right)
}

export function processTreePids(rows: ProcessRow[], roots: number[]): number[]
{
  const selected = new Set(roots.filter(validPid))
  let changed = true
  while (changed)
  {
    changed = false
    for (const row of rows)
    {
      if (!selected.has(row.ppid) || selected.has(row.pid)) continue
      selected.add(row.pid)
      changed = true
    }
  }
  return [...selected].sort((left, right) => left - right)
}

export async function processTreeRss(
  roots: number[],
  excludedRoots: number[] = []
): Promise<RssSample>
{
  const rows = await processTable()
  const pids = processTreePids(rows, roots)
  const excluded = new Set(processTreePids(rows, excludedRoots))
  const selected = new Set(pids)
  return {
    elapsedMs: 0,
    rssBytes: rows
      .filter((row) => selected.has(row.pid) && !excluded.has(row.pid))
      .reduce((sum, row) => sum + row.rssBytes, 0),
    pids: pids.filter((pid) => !excluded.has(pid)),
  }
}

export class ProcessTreeRssSampler
{
  private readonly samples: RssSample[] = []
  private timer?: NodeJS.Timeout
  private startedAt = 0
  private inFlight?: Promise<void>

  constructor(
    private readonly roots: () => number[],
    private readonly intervalMs: number,
    private readonly excludedRoots: () => number[] = () => []
  )
  {}

  async start(): Promise<void>
  {
    if (this.timer) throw new Error('RSS sampler already started')
    this.startedAt = performance.now()
    await this.takeSample()
    this.timer = setInterval(() => void this.takeSample(), this.intervalMs)
    this.timer.unref()
  }

  async stop(): Promise<RssSample[]>
  {
    if (this.timer)
    {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.inFlight) await this.inFlight
    await this.takeSample()
    return [...this.samples]
  }

  private async takeSample(): Promise<void>
  {
    if (this.inFlight) return this.inFlight
    const task = (async () =>
    {
      const sample = await processTreeRss(this.roots(), this.excludedRoots())
      sample.elapsedMs = performance.now() - this.startedAt
      this.samples.push(sample)
    })()
    this.inFlight = task
    try
    {
      await task
    }
    finally
    {
      if (this.inFlight === task) this.inFlight = undefined
    }
  }
}

function signalOwnedGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): void
{
  if (!child.pid || !validPid(child.pid)) return
  try
  {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  }
  catch
  {
    // the process may have exited between the liveness check and signal
  }
}

function delay(ms: number): Promise<void>
{
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForPidsToExit(
  pids: number[],
  timeoutMs: number
): Promise<boolean>
{
  const deadline = Date.now() + timeoutMs
  const targets = new Set(pids.filter(validPid))
  while (Date.now() < deadline)
  {
    const rows = await processTable()
    if (!rows.some((row) => targets.has(row.pid))) return true
    await delay(50)
  }
  return false
}

async function waitForProcessGroupToExit(
  pgid: number,
  timeoutMs: number
): Promise<boolean>
{
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline)
  {
    if (processGroupPids(await processTable(), pgid).length === 0) return true
    await delay(50)
  }
  return processGroupPids(await processTable(), pgid).length === 0
}

export class OwnedChild
{
  private child?: ChildProcessWithoutNullStreams
  private closePromise?: Promise<void>
  private stdoutTail = ''
  private stderrTail = ''

  constructor(private readonly launch: ProcessLaunchConfig)
  {}

  get pid(): number | undefined
  {
    return this.child?.pid
  }

  get exited(): boolean
  {
    return (
      this.child === undefined ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
  }

  diagnostics(): { stdout: string; stderr: string }
  {
    return { stdout: this.stdoutTail, stderr: this.stderrTail }
  }

  async start(): Promise<void>
  {
    if (this.child) throw new Error('owned child already started')
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      env: this.launch.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    child.stdin.end()
    this.child = child
    this.closePromise = new Promise((resolve) => child.once('close', resolve))
    child.stdout.on('data', (chunk: Buffer) =>
    {
      this.stdoutTail = appendTail(this.stdoutTail, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) =>
    {
      this.stderrTail = appendTail(this.stderrTail, chunk)
    })
    await new Promise<void>((resolve, reject) =>
    {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  }

  async crash(): Promise<number[]>
  {
    const child = this.child
    if (!child) throw new Error('owned child is not running')
    const rows = await processTable()
    const descendants = [
      ...new Set([
        ...processTreePids(rows, [child.pid!]),
        ...processGroupPids(rows, child.pid!),
      ]),
    ].sort((left, right) => left - right)
    signalOwnedGroup(child, 'SIGKILL')
    await this.closePromise
    const groupExited = await waitForProcessGroupToExit(child.pid!, 2_000)
    this.child = undefined
    this.closePromise = undefined
    if (!groupExited)
    {
      throw new Error(`owned process group ${child.pid} survived SIGKILL`)
    }
    return descendants
  }

  async stop(): Promise<{ descendants: number[]; allExited: boolean }>
  {
    const child = this.child
    if (!child) return { descendants: [], allExited: true }
    const rows = await processTable()
    const descendants = [
      ...new Set([
        ...processTreePids(rows, [child.pid!]),
        ...processGroupPids(rows, child.pid!),
      ]),
    ].sort((left, right) => left - right)
    signalOwnedGroup(child, 'SIGTERM')
    const closed = this.closePromise ?? Promise.resolve()
    await Promise.race([closed, delay(2_000)])
    let groupExited = await waitForProcessGroupToExit(child.pid!, 2_000)
    if (!groupExited)
    {
      signalOwnedGroup(child, 'SIGKILL')
      await Promise.race([closed, delay(2_000)])
      groupExited = await waitForProcessGroupToExit(child.pid!, 2_000)
    }
    this.child = undefined
    this.closePromise = undefined
    return {
      descendants,
      allExited: groupExited && (await waitForPidsToExit(descendants, 2_000)),
    }
  }
}

export async function waitForHttp(
  url: string,
  timeoutMs: number,
  child: OwnedChild
): Promise<void>
{
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'
  while (Date.now() < deadline)
  {
    try
    {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    }
    catch (error)
    {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (child.exited) break
    await delay(100)
  }
  const diagnostics = child.diagnostics()
  throw new Error(
    `child did not become ready at ${url}: ${lastError}\n` +
      `stdout tail:\n${diagnostics.stdout}\nstderr tail:\n${diagnostics.stderr}`
  )
}

export async function randomLoopbackPort(): Promise<number>
{
  const server = createServer()
  await new Promise<void>((resolve, reject) =>
  {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
  {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('could not allocate a random loopback port')
  }
  const port = address.port
  await new Promise<void>((resolve, reject) =>
  {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return port
}

export async function assertBrowserOriginDenied(
  url: string,
  origin: string
): Promise<void>
{
  const response = await fetch(url, {
    headers: { Origin: origin },
    signal: AbortSignal.timeout(2_000),
  })
  const allowed = response.headers.get('access-control-allow-origin')
  if (allowed === '*' || allowed === origin)
  {
    throw new Error(
      `stock MLX server allowed untrusted browser origin ${origin}`
    )
  }
}
