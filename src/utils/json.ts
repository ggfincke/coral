// src/utils/json.ts
// parse JSON and read or write files

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
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

// write a value as pretty-printed JSON through a unique same-dir temp. exclusive
// temp creation prevents writers from colliding, while rename keeps each final
// value whole. the caller still owns any domain-level merge semantics
export function writeJsonFile(path: string, value: unknown): void
{
  ensureParentDir(path)
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
