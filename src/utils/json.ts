// src/utils/json.ts
// parse, deep-freeze, and read or write JSON

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isPlainObject } from './guards.js'
import { ensureParentDir } from './fs.js'

// parse JSON, returning undefined on any parse error
export function tryParseJson(text: string): unknown
{
  try
  {
    return JSON.parse(text)
  }
  catch
  {
    return undefined
  }
}

// deep copy of a JSON-shaped value with every array and object frozen
export function cloneFrozenJson<T>(value: T): T
{
  if (Array.isArray(value))
  {
    return Object.freeze(value.map((item) => cloneFrozenJson(item))) as T
  }
  if (typeof value === 'object' && value !== null)
  {
    const clone = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneFrozenJson(item)])
    )
    return Object.freeze(clone) as T
  }
  return value
}

// read a JSON file, returning undefined when absent, unreadable, or invalid
function readJsonFile(path: string): unknown | undefined
{
  try
  {
    return tryParseJson(readFileSync(path, 'utf-8'))
  }
  catch
  {
    return undefined
  }
}

// read a JSON file that must contain a plain object
export function readJsonObjectFile<T extends object = Record<string, unknown>>(
  path: string
): T | undefined
{
  const parsed = readJsonFile(path)
  return isPlainObject(parsed) ? (parsed as T) : undefined
}

// write Coral-private state as pretty-printed JSON inside a 0700 parent dir
export function writeJsonFile(path: string, value: unknown): void
{
  ensureParentDir(path)
  replaceJsonFile(path, value)
}

// write a user-chosen output path as a 0600 file. missing parents get default
// permissions and an existing parent keeps its mode, since it may be a repo root
export function writeUserJsonFile(path: string, value: unknown): void
{
  mkdirSync(dirname(path), { recursive: true })
  replaceJsonFile(path, value)
}

// replace the file through a unique same-dir 0600 temp. exclusive temp creation
// prevents writers from colliding, while rename keeps each final value whole.
// the caller still owns any domain-level merge semantics
function replaceJsonFile(path: string, value: unknown): void
{
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  )
  let writeFailure: { error: unknown } | undefined

  try
  {
    writeFileSync(tmp, JSON.stringify(value, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    })
    if (process.platform !== 'win32') chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  }
  catch (error)
  {
    writeFailure = { error }
  }
  let cleanupFailure: { error: unknown } | undefined
  try
  {
    rmSync(tmp, { force: true })
  }
  catch (error)
  {
    cleanupFailure = { error }
  }

  if (writeFailure) throw writeFailure.error
  if (cleanupFailure) throw cleanupFailure.error
}
