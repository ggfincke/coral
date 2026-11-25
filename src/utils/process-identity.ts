// src/utils/process-identity.ts
// start-time & boot identity reads that tell a live owner from a reused pid

import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PS_PATH = '/bin/ps'
// one clock & locale, so a recorded start time stays comparable as a string
const PS_ENV = { ...process.env, TZ: 'UTC', LC_ALL: 'C' }
// start time, group, & state from one ps row
const IDENTITY_COLUMNS = ['-o', 'lstart=', '-o', 'pgid=', '-o', 'stat=']
// ps lstart in the C locale, e.g. "Sun Nov  8 17:44:26 2026"
const PS_START_TIME =
  /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}/
// "<boot id>:<start ticks since boot>" from procfs
const LINUX_START_TIME = /^[0-9a-f-]{36}:\d+$/
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

// procfs start ticks count from boot, so a wall-clock step never moves them
// the way it moves ps lstart; the boot id keeps ticks from two boots apart
function linuxStartTime(pid: number): string | undefined
{
  const bootId = linuxBootId()
  if (!bootId) return undefined
  try
  {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // fields after "(comm)" start at state (field 3); starttime is field 22
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = fields[19]
    if (fields[0] === 'Z' || !ticks || !/^\d+$/.test(ticks)) return undefined
    return `${bootId}:${ticks}`
  }
  catch
  {
    return undefined
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

// whether a recorded value is a known start time rather than a placeholder
export function isProcessStartTime(value: string): boolean
{
  return (
    LINUX_START_TIME.test(value) || PS_START_TIME.exec(value)?.[0] === value
  )
}

// an opaque start time for a live pid, equal only for the same process, or
// undefined when the process is gone, a zombie, or unreadable
export function processStartTimeSync(pid: number): string | undefined
{
  if (process.platform === 'linux') return linuxStartTime(pid)
  if (process.platform === 'darwin') return psStartTime(pid)
  return undefined
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
