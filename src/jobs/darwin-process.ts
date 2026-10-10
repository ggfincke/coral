// src/jobs/darwin-process.ts
// query macOS process birth identities without compiler or addon dependencies

import { execFile } from 'node:child_process'
import { isPlainObject } from '../utils/guards.js'

export interface DarwinProcessIdentity
{
  pid: number
  uniqueId: string
  parentUniqueId: string
}

const MAX_PROCESSES = 65_536
const QUERY_BATCH_SIZE = 2048
const SKIPPABLE_ERRORS = new Set([1, 3, 13])

// libproc's unique-parent value survives reparenting, but cannot reconstruct an
// intermediate process that exited before any snapshot observed its identity
const QUERY_SCRIPT = `
ObjC.import('Foundation')
ObjC.bindFunction('malloc', ['void *', ['unsigned long']])
ObjC.bindFunction('free', ['void', ['void *']])
ObjC.bindFunction('__error', ['void *', []])
ObjC.bindFunction('dlopen', ['void *', ['char *', 'int']])
$.dlopen('/usr/lib/libproc.dylib', 2)
ObjC.bindFunction('proc_listallpids', ['int', ['void *', 'int']])
ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'uint64_t', 'void *', 'int']])
function encoded(buffer, length) {
  return ObjC.unwrap($.NSData.dataWithBytesLength(buffer, length).base64EncodedStringWithOptions(0))
}
function info(pid, flavor, size) {
  const buffer = $.malloc(size)
  if (!buffer) throw Error('Cannot allocate process identity buffer')
  try {
    const count = $.proc_pidinfo(pid, flavor, 0, buffer, size)
    if (count !== size) return { count: count, error: encoded($.__error(), 4) }
    return { count: count, bytes: encoded(buffer, size) }
  } finally { $.free(buffer) }
}
function run(args) {
  const pids = JSON.parse(args[0])
  if (pids === null) {
    const needed = $.proc_listallpids(null, 0)
    if (needed <= 0 || needed > ${MAX_PROCESSES}) throw Error('Invalid process enumeration size')
    const capacity = Math.min(needed + 1024, ${MAX_PROCESSES})
    const buffer = $.malloc(capacity * 4)
    if (!buffer) throw Error('Cannot allocate process enumeration buffer')
    try {
      const count = $.proc_listallpids(buffer, capacity * 4)
      if (count <= 0 || count >= capacity) throw Error('Incomplete process enumeration')
      return JSON.stringify({ count: count, bytes: encoded(buffer, count * 4) })
    } finally { $.free(buffer) }
  }
  return JSON.stringify(pids.map(function(pid) {
    return { pid: pid, before: info(pid, 17, 56), bsd: info(pid, 13, 64), after: info(pid, 17, 56) }
  }))
}
`

function invoke(pids: number[] | null): Promise<unknown>
{
  return new Promise((resolve, reject) =>
  {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', QUERY_SCRIPT, JSON.stringify(pids)],
      {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
      {
        if (error)
        {
          reject(
            new Error(
              `Cannot verify macOS task process identities: ${stderr.trim() || error.message}`
            )
          )
          return
        }
        try
        {
          resolve(JSON.parse(stdout) as unknown)
        }
        catch
        {
          reject(
            new Error('macOS process identity helper returned invalid JSON')
          )
        }
      }
    )
  })
}

function decodeBytes(value: unknown, expected: number): Buffer
{
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.length % 4 !== 0
  )
  {
    throw new Error('macOS process identity helper returned invalid bytes')
  }
  const buffer = Buffer.from(value, 'base64')
  if (buffer.length !== expected)
  {
    throw new Error(
      'macOS process identity helper returned an unexpected ABI size'
    )
  }
  return buffer
}

function decodeInfo(value: unknown, size: number): Buffer | undefined
{
  if (!isPlainObject(value) || !Number.isInteger(value.count))
  {
    throw new Error('macOS process identity helper returned an invalid record')
  }
  if (value.count === size) return decodeBytes(value.bytes, size)
  const error = decodeBytes(value.error, 4).readInt32LE()
  if (value.count === 0 && SKIPPABLE_ERRORS.has(error)) return undefined
  throw new Error(
    `macOS process identity query failed (size ${String(value.count)}, errno ${error})`
  )
}

function validPid(value: unknown): value is number
{
  return (
    Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0x7fffffff
  )
}

export async function queryDarwinProcesses(
  pids?: number[]
): Promise<DarwinProcessIdentity[]>
{
  if (process.platform !== 'darwin' || !process.getuid)
  {
    throw new Error('macOS process identities require macOS')
  }
  let selected: number[]
  if (pids !== undefined)
  {
    if (pids.length > MAX_PROCESSES || !pids.every(validPid))
    {
      throw new Error('Invalid process IDs for macOS task ownership query')
    }
    selected = [...new Set(pids)]
  }
  else
  {
    const enumeration = await invoke(null)
    if (
      !isPlainObject(enumeration) ||
      !Number.isInteger(enumeration.count) ||
      Number(enumeration.count) <= 0 ||
      Number(enumeration.count) > MAX_PROCESSES
    )
    {
      throw new Error(
        'macOS process identity helper returned an invalid enumeration'
      )
    }
    const bytes = decodeBytes(enumeration.bytes, Number(enumeration.count) * 4)
    selected = []
    for (let offset = 0; offset < bytes.length; offset += 4)
    {
      const pid = bytes.readInt32LE(offset)
      if (pid === 0) continue
      if (!validPid(pid))
        throw new Error(
          'macOS process enumeration contained an invalid process ID'
        )
      selected.push(pid)
    }
    selected = [...new Set(selected)]
  }
  const result: DarwinProcessIdentity[] = []
  for (let offset = 0; offset < selected.length; offset += QUERY_BATCH_SIZE)
  {
    const batch = selected.slice(offset, offset + QUERY_BATCH_SIZE)
    const values = await invoke(batch)
    if (!Array.isArray(values) || values.length !== batch.length)
    {
      throw new Error(
        'macOS process identity helper returned an incomplete query'
      )
    }
    for (const [index, value] of values.entries())
    {
      if (!isPlainObject(value) || value.pid !== batch[index])
      {
        throw new Error(
          'macOS process identity helper returned a mismatched process ID'
        )
      }
      const before = decodeInfo(value.before, 56)
      const bsd = decodeInfo(value.bsd, 64)
      const after = decodeInfo(value.after, 56)
      if (!before || !bsd || !after) continue
      if (bsd.readUInt32LE(0) !== value.pid)
      {
        throw new Error('macOS process identity does not match its BSD record')
      }
      // omit foreign users, zombies, and identities that changed during this query
      if (
        bsd.readUInt32LE(36) !== process.getuid() ||
        bsd.readUInt32LE(12) === 5 ||
        before.readBigUInt64LE(16) !== after.readBigUInt64LE(16)
      )
        continue
      const uniqueId = after.readBigUInt64LE(16)
      const parentUniqueId = after.readBigUInt64LE(24)
      if (uniqueId === 0n)
        throw new Error('macOS returned an empty process birth identity')
      result.push({
        pid: value.pid as number,
        uniqueId: uniqueId.toString(),
        parentUniqueId: parentUniqueId.toString(),
      })
    }
  }
  return result
}
