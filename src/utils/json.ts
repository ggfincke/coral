// src/utils/json.ts
// JSON parse & file helpers

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
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

// write a value as pretty-printed JSON, creating the parent dir if needed.
// write-then-rename so a crash mid-write can't leave a truncated file — the
// rename is atomic, so readers see either the old contents or the new
export function writeJsonFile(path: string, value: unknown): void
{
  ensureParentDir(path)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  renameSync(tmp, path)
}
