// src/utils/process-identity.ts
// start-time & boot identity reads that tell a live owner from a reused pid

import { execFile, execFileSync } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'

const PS_PATH = '/bin/ps'
// one clock & locale, so a recorded start time stays comparable as a string
const PS_ENV = { ...process.env, TZ: 'UTC', LC_ALL: 'C' }
// start time, group, & state from one ps row
const IDENTITY_COLUMNS = ['-o', 'lstart=', '-o', 'pgid=', '-o', 'stat=']
// ps lstart in the C locale, e.g. "Sun Nov  8 17:44:26 2026"
const PS_START_TIME =
  /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}/
// "<boot id>:<pid namespace inode>:<start ticks since boot>" from procfs
const LINUX_START_TIME = /^([0-9a-f-]{36}):(\d+):(\d+)$/
// the lease check runs inside a SQLite write transaction, so bound the spawn
const SYNC_READ_TIMEOUT_MS = 1_000
const BOOT_ID = /^[0-9a-f-]{36}$/
let bootIdentityValue: Promise<string | undefined> | undefined

// "<lstart> <pgid>" from one ps row; a missing or zombie process reads as gone
function identityFromRow(row: string): string | undefined
{
  if (!row) return undefined
  const state = row.split(/\s+/).at(-1)!
  if (state.startsWith('Z')) return undefined
  return row.slice(0, -state.length).trim() || undefined
}

function linuxBootId(): string | undefined
{
  try
  {
    const identity = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
      .trim()
      .toLowerCase()
    return BOOT_ID.test(identity) ? identity : undefined
  }
  catch
  {
    return undefined
  }
}

// the inode of this process's pid namespace, e.g. "4026531836" from
// "pid:[4026531836]"; a recorded pid only names a process inside it
function linuxPidNamespace(): string | undefined
{
  try
  {
    return /^pid:\[(\d+)\]$/.exec(readlinkSync('/proc/self/ns/pid'))?.[1]
  }
  catch
  {
    return undefined
  }
}

// procfs start ticks count from boot, so a wall-clock step never moves them
// the way it moves ps lstart; undefined for a gone, zombie, or unreadable entry
function linuxStartTicks(procEntry: string): string | undefined
{
  try
  {
    const stat = readFileSync(`/proc/${procEntry}/stat`, 'utf8')
    // fields after "(comm)" start at state (field 3); starttime is field 22
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = fields[19]
    if (fields[0] === 'Z' || !ticks || !/^\d+$/.test(ticks)) return undefined
    return ticks
  }
  catch
  {
    return undefined
  }
}

// /proc/<pid> names the right process only when the mounted procfs belongs
// to this pid namespace, as after `unshare -p` without --mount-proc it may not
function procMatchesPidNamespace(): boolean
{
  try
  {
    return readlinkSync('/proc/self') === String(process.pid)
  }
  catch
  {
    return false
  }
}

// a record from another boot is dead whatever its pid; one from another pid
// namespace names an unrelated pid here, so it stays unknown (alive)
function isLinuxRecordGone(
  pid: number,
  [, bootId, namespace, ticks]: RegExpExecArray
): boolean
{
  const liveBootId = linuxBootId()
  if (!liveBootId) return false
  if (liveBootId !== bootId) return true
  if (linuxPidNamespace() !== namespace) return false
  if (isPidAbsent(pid)) return true
  if (!procMatchesPidNamespace()) return false
  const liveTicks = linuxStartTicks(String(pid))
  return liveTicks !== undefined && liveTicks !== ticks
}

// only ESRCH proves absence; EPERM means some process holds the pid
function isPidAbsent(pid: number): boolean
{
  try
  {
    process.kill(pid, 0)
    return false
  }
  catch (error)
  {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH'
  }
}

function psStartTime(pid: number): string | undefined
{
  try
  {
    const row = execFileSync(
      PS_PATH,
      ['-p', String(pid), ...IDENTITY_COLUMNS],
      {
        env: PS_ENV,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: SYNC_READ_TIMEOUT_MS,
      }
    )
    return PS_START_TIME.exec(identityFromRow(row.trim()) ?? '')?.[0]
  }
  catch
  {
    return undefined
  }
}

// an opaque start time for this process, equal only for the same process in
// the same boot & pid namespace, or undefined when it cannot be read
export function ownProcessStartTime(): string | undefined
{
  if (process.platform === 'linux')
  {
    const bootId = linuxBootId()
    const namespace = linuxPidNamespace()
    const ticks = linuxStartTicks('self')
    return bootId && namespace && ticks
      ? `${bootId}:${namespace}:${ticks}`
      : undefined
  }
  if (process.platform === 'darwin') return psStartTime(process.pid)
  return undefined
}

// whether a pid recorded w/ a start time is conclusively no longer that
// process: absent, or running one whose known start time differs. any value
// that is not a known start time for this platform only recovers on absence
export function isRecordedProcessGone(
  pid: number,
  recordedStartTime: string
): boolean
{
  const linux = LINUX_START_TIME.exec(recordedStartTime)
  if (linux && process.platform === 'linux')
    return isLinuxRecordGone(pid, linux)
  if (isPidAbsent(pid)) return true
  if (process.platform !== 'darwin') return false
  if (PS_START_TIME.exec(recordedStartTime)?.[0] !== recordedStartTime)
    return false
  const liveStartTime = psStartTime(pid)
  return liveStartTime !== undefined && liveStartTime !== recordedStartTime
}

// start time and process group distinguish a live owner from a reused pid
export function processIdentity(pid: number): Promise<string | undefined>
{
  return new Promise((resolve, reject) =>
  {
    execFile(
      PS_PATH,
      ['-p', String(pid), ...IDENTITY_COLUMNS],
      { env: PS_ENV },
      (error, stdout) =>
      {
        if (error && Number(error.code) !== 1) reject(error)
        else resolve(identityFromRow(stdout.trim()))
      }
    )
  })
}

// whether a recorded value has the shape of a boot identity
export function isBootIdentity(value: string): boolean
{
  return BOOT_ID.test(value)
}

// a record from an earlier boot cannot own any live process, whatever its pid.
// macOS ownership depends on it; on Linux it is a best-effort shortcut, so an
// unreadable boot id leaves ownership to the identity checks as before
export function bootIdentity(): Promise<string | undefined>
{
  bootIdentityValue ??= new Promise((resolve, reject) =>
  {
    if (process.platform === 'linux')
    {
      resolve(linuxBootId())
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
