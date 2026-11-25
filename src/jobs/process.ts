// src/jobs/process.ts
// own task process groups through launch barriers, identity checks, and joined exit

import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { ensurePrivateDir } from '../utils/fs.js'
import { toErrorMessage } from '../utils/errors.js'
import { writeJsonFile } from '../utils/json.js'
import { sanitizeUntrustedText } from '../utils/untrusted-text.js'
import { jobDirectory } from './store.js'
import { queryDarwinProcesses } from './darwin-process.js'

const OUTPUT_LIMIT = 1024 * 1024
const PROCESS_TOKEN_KEY = 'CORAL_JOB_PROCESS_TOKEN'
const BOOT_ID = /^[0-9a-f-]{36}$/
let bootIdentityValue: Promise<string | undefined> | undefined

// a record from an earlier boot cannot own any live process, whatever its pid.
// macOS ownership depends on it; on Linux it is a best-effort shortcut, so an
// unreadable boot id leaves ownership to the identity checks as before
function bootIdentity(): Promise<string | undefined>
{
  bootIdentityValue ??= new Promise((resolve, reject) =>
  {
    if (process.platform === 'linux')
    {
      try
      {
        const identity = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
          .trim()
          .toLowerCase()
        resolve(BOOT_ID.test(identity) ? identity : undefined)
      }
      catch
      {
        resolve(undefined)
      }
      return
    }
    execFile(
      '/usr/sbin/sysctl',
      ['-n', 'kern.bootsessionuuid'],
      (error, stdout) =>
      {
        const identity = stdout.trim().toLowerCase()
        if (error || !BOOT_ID.test(identity))
          reject(
            new Error(
              'Cannot establish the macOS boot identity for task ownership.'
            )
          )
        else resolve(identity)
      }
    )
  })
  return bootIdentityValue
}

export interface OwnedJobProcess
{
  pid: number
  token: string
  identity: string
  uniqueId?: string
  bootId?: string
}

export interface JobCommandOptions
{
  cwd: string
  signal?: AbortSignal
  timeoutMs?: number
  jobId?: string
}

export function assertJobsPlatform(): void
{
  if (process.platform !== 'darwin' && process.platform !== 'linux')
  {
    throw new Error('Background coding tasks currently require macOS or Linux.')
  }
}

function ps(args: string[], maxBuffer = OUTPUT_LIMIT): Promise<string>
{
  return new Promise((resolve, reject) =>
  {
    execFile(
      '/bin/ps',
      args,
      { maxBuffer, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } },
      (error, stdout) =>
      {
        if (error && Number(error.code) !== 1) reject(error)
        else resolve(stdout.trim())
      }
    )
  })
}

// inherited launch tokens identify ordinary descendants that create a new session
async function tokenMembers(token: string): Promise<number[]>
{
  const rows = await ps(
    ['axeww', '-o', 'pid=', '-o', 'stat=', '-o', 'args='],
    64 * 1024 * 1024
  )
  const marker = `${PROCESS_TOKEN_KEY}=${token}`
  return rows.split('\n').flatMap((row) =>
  {
    const fields = row.trim().split(/\s+/)
    return fields.includes(marker) && !fields[1]?.startsWith('Z')
      ? [Number(fields[0])]
      : []
  })
}

// the start time in a processIdentity value ("<lstart> <pgid>"), or undefined
// when the value is not one this module recorded
function identityStartMs(identity: string): number | undefined
{
  const split = identity.trimEnd().lastIndexOf(' ')
  const started = Date.parse(identity.slice(0, split))
  return split > 0 && Number.isFinite(started) ? started : undefined
}

// start time and process group distinguish a live owner from a reused pid
export async function processIdentity(
  pid: number
): Promise<string | undefined>
{
  const row = await ps([
    '-p',
    String(pid),
    '-o',
    'lstart=',
    '-o',
    'pgid=',
    '-o',
    'stat=',
  ])
  if (!row) return undefined
  const state = row.split(/\s+/).at(-1)!
  if (state.startsWith('Z')) return undefined
  return row.slice(0, -state.length).trim() || undefined
}

async function groupMembers(pid: number): Promise<number[]>
{
  const rows = await ps(['-ax', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='])
  return rows.split('\n').flatMap((row) =>
  {
    const [member, group, state] = row.trim().split(/\s+/)
    return Number(group) === pid && !state?.startsWith('Z')
      ? [Number(member)]
      : []
  })
}

export async function captureOwnedProcess(
  pid: number,
  token: string
): Promise<OwnedJobProcess>
{
  const identity = await processIdentity(pid)
  if (!identity)
    throw new Error('Task process exited before its launch was recorded.')
  if (Number(identity.trim().split(/\s+/).at(-1)) !== pid)
  {
    throw new Error(
      'Task process did not receive an independent process group.'
    )
  }
  if (process.platform === 'darwin')
  {
    const birth = (await queryDarwinProcesses([pid]))[0]
    if (!birth)
      throw new Error(
        'Task process exited before its birth identity was recorded.'
      )
    return {
      pid,
      token,
      identity,
      uniqueId: birth.uniqueId,
      bootId: await bootIdentity(),
    }
  }
  const bootId = await bootIdentity()
  return { pid, token, identity, ...(bootId ? { bootId } : {}) }
}

// kernel parent identities survive reparenting and cover protected macOS binaries
async function darwinDescendants(
  owner: OwnedJobProcess
): Promise<Map<number, string>>
{
  const descendants = new Map<number, string>()
  if (process.platform !== 'darwin' || !owner.uniqueId || !owner.bootId)
    return descendants
  const processes = await queryDarwinProcesses()
  const identities = new Set([owner.uniqueId])
  let changed = true
  while (changed)
  {
    changed = false
    for (const candidate of processes)
    {
      if (descendants.has(candidate.pid)) continue
      if (
        identities.has(candidate.uniqueId) ||
        identities.has(candidate.parentUniqueId)
      )
      {
        descendants.set(candidate.pid, candidate.uniqueId)
        identities.add(candidate.uniqueId)
        changed = true
      }
    }
  }
  return descendants
}

export async function ownedGroupMembers(
  owner: OwnedJobProcess
): Promise<number[]>
{
  decodeOwner(owner)
  if (owner.bootId)
  {
    const current = await bootIdentity()
    if (current !== undefined && current !== owner.bootId) return []
  }
  const members = await groupMembers(owner.pid)
  const detached = await tokenMembers(owner.token)
  const native = await darwinDescendants(owner)
  const proven = new Set([...detached, ...native.keys()])
  if (!members.length) return [...proven]
  const identity = await processIdentity(owner.pid)
  if (
    native.get(owner.pid) === owner.uniqueId &&
    owner.uniqueId &&
    identity !== undefined &&
    identity !== owner.identity
  )
    throw new Error(
      `Cannot establish ownership of task process group ${owner.pid}; queue is blocked.`
    )
  if (
    identity === owner.identity &&
    (!owner.uniqueId || native.get(owner.pid) === owner.uniqueId)
  )
    return [...new Set([...members, ...proven])]
  // * a pgid in use is never reallocated, so a leader pid that started later
  // was reused after the recorded group emptied; never signal its members. a
  // leader still holding our token is ours despite a wall-clock step
  const recordedStart = identityStartMs(owner.identity)
  const liveStart =
    identity === undefined ? undefined : identityStartMs(identity)
  if (
    recordedStart !== undefined &&
    liveStart !== undefined &&
    liveStart > recordedStart &&
    !proven.has(owner.pid) &&
    (!owner.uniqueId || native.get(owner.pid) !== owner.uniqueId)
  )
    return [...proven]

  // after the leader exits, every remaining descendant must retain the launch token
  for (const member of members)
  {
    if (proven.has(member)) continue
    const args = await ps(['eww', '-p', String(member), '-o', 'args='])
    if (!args) continue
    const marker = `${PROCESS_TOKEN_KEY}=${owner.token}`
    if (!args.split(/\s+/).includes(marker))
    {
      throw new Error(
        `Cannot establish ownership of task process group ${owner.pid}; queue is blocked.`
      )
    }
  }
  return [...new Set([...members, ...proven])]
}

async function waitForGroup(
  owner: OwnedJobProcess,
  durationMs: number
): Promise<boolean>
{
  const until = Date.now() + durationMs
  do
  {
    if (!(await ownedGroupMembers(owner)).length) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < until)
  return false
}

export async function terminateOwnedGroup(
  owner: OwnedJobProcess
): Promise<void>
{
  for (const signal of ['SIGTERM', 'SIGKILL'] as const)
  {
    const members = await ownedGroupMembers(owner)
    if (!members.length) return
    const native = await darwinDescendants(owner)
    // * signal the whole group only when every live member is proven ours; a
    // reused leader pid can head a foreign group while our token holders live on
    const group = await groupMembers(owner.pid)
    if (group.length && group.every((pid) => members.includes(pid)))
    {
      try
      {
        process.kill(-owner.pid, signal)
      }
      catch (error)
      {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    for (const member of members)
    {
      const identity = await processIdentity(member)
      if (!identity) continue
      const args = await ps(['eww', '-p', String(member), '-o', 'args='])
      if (!args.split(/\s+/).includes(`${PROCESS_TOKEN_KEY}=${owner.token}`))
      {
        const uniqueId = native.get(member)
        if (
          !uniqueId ||
          (await queryDarwinProcesses([member]))[0]?.uniqueId !== uniqueId
        )
          continue
      }
      if ((await processIdentity(member)) !== identity) continue
      try
      {
        process.kill(member, signal)
      }
      catch (error)
      {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    if (await waitForGroup(owner, 1500)) return
  }
  throw new Error(
    `Task process group ${owner.pid} has not stopped; queue is blocked.`
  )
}

function processesDirectory(id: string): string
{
  const directory = join(jobDirectory(id), 'processes')
  ensurePrivateDir(directory)
  return directory
}

export function decodeOwner(value: unknown): OwnedJobProcess
{
  const owner = value as Partial<OwnedJobProcess> | null
  if (
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    Number(owner.pid) <= 1 ||
    typeof owner.token !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(owner.token) ||
    typeof owner.identity !== 'string' ||
    !owner.identity ||
    (owner.uniqueId !== undefined &&
      (typeof owner.uniqueId !== 'string' ||
        !/^[1-9][0-9]*$/.test(owner.uniqueId))) ||
    (owner.bootId !== undefined &&
      (typeof owner.bootId !== 'string' || !BOOT_ID.test(owner.bootId)))
  )
    throw new Error('Invalid task process ownership record; queue is blocked.')
  return owner as OwnedJobProcess
}

export async function cleanupJobProcesses(id: string): Promise<void>
{
  const directory = processesDirectory(id)
  for (const name of readdirSync(directory))
  {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
    const path = join(directory, name)
    try
    {
      const owner = decodeOwner(JSON.parse(readFileSync(path, 'utf8')))
      await terminateOwnedGroup(owner)
    }
    catch (error)
    {
      throw new Error(
        `${toErrorMessage(error)} Process record: ${path}. If none of that task's commands are still running, remove the record and retry.`,
        { cause: error }
      )
    }
    rmSync(path)
  }
}

export async function runJobCommand(
  command: string,
  options: JobCommandOptions
): Promise<{ ok: boolean; output: string }>
{
  assertJobsPlatform()
  options.signal?.throwIfAborted()
  const token = randomUUID()
  // no command starts until its independently owned process group is durably recorded
  const child = spawn(
    '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-p',
      '-c',
      'IFS= builtin read -r coral_launch || builtin exit 125; builtin exec /bin/bash -c "$1"',
      'coral-task',
      command,
    ],
    {
      cwd: options.cwd,
      detached: true,
      env: { ...process.env, [PROCESS_TOKEN_KEY]: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  let output = ''
  let truncated = false
  const append = (text: string) =>
  {
    output += text
    if (output.length > OUTPUT_LIMIT)
    {
      output = output.slice(-OUTPUT_LIMIT)
      truncated = true
    }
  }
  // one decoder per stream: a multibyte character may straddle two reads
  const decoders = [child.stdout, child.stderr].map((stream) =>
  {
    const decoder = new StringDecoder('utf8')
    stream.on('data', (chunk: Buffer) => append(decoder.write(chunk)))
    return decoder
  })
  child.stdin.on('error', () =>
  {})
  const exited = new Promise<number | null>((resolve, reject) =>
  {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  // attach a rejection handler before awaiting process-identity I/O
  void exited.catch(() =>
  {})
  let owner: OwnedJobProcess | undefined
  let recordPath: string | undefined
  let stop: Promise<void> | undefined
  let stopError: unknown
  let cancelled = false
  const requestStop = () =>
  {
    cancelled = true
    child.stdin.end()
    if (owner && !stop)
    {
      stop = terminateOwnedGroup(owner).catch((error: unknown) =>
      {
        stopError = error
        // wake the worker even when group ownership cannot be established
        child.kill('SIGTERM')
      })
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try
  {
    if (!child.pid) throw new Error('Could not launch task command.')
    owner = await captureOwnedProcess(child.pid, token)
    if (options.jobId)
    {
      recordPath = join(processesDirectory(options.jobId), `${token}.json`)
      writeJsonFile(recordPath, owner)
    }
    options.signal?.addEventListener('abort', requestStop, { once: true })
    if (options.timeoutMs !== undefined)
    {
      timer = setTimeout(requestStop, Math.max(1, options.timeoutMs))
    }
    if (options.signal?.aborted) requestStop()
    else child.stdin.end('start\n')
    const code = await exited
    for (const decoder of decoders) append(decoder.end())
    await stop
    if (stopError) throw stopError
    const leftover = (await ownedGroupMembers(owner)).length > 0
    if (leftover) await terminateOwnedGroup(owner)
    if (recordPath) rmSync(recordPath)
    const result =
      `${truncated ? '[Earlier command output truncated]\n' : ''}${output}` +
      (cancelled ? '\nCommand cancelled or its deadline expired.' : '') +
      (leftover
        ? '\nBackground descendants were stopped; task commands must remain foreground.'
        : '') +
      (code !== 0 && !output
        ? `\nCommand exited with status ${String(code)}.`
        : '')
    return {
      ok: code === 0 && !cancelled && !leftover,
      output: sanitizeUntrustedText(result).slice(-OUTPUT_LIMIT),
    }
  }
  finally
  {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', requestStop)
    child.stdin.end()
    if (owner)
    {
      await terminateOwnedGroup(owner)
      if (recordPath) rmSync(recordPath, { force: true })
    }
    else child.kill('SIGTERM')
    await exited.catch(() =>
    {})
  }
}
