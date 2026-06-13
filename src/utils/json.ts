// src/utils/json.ts
// JSON parse & file helpers

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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

// write a value as pretty-printed JSON, creating the parent dir if needed
export function writeJsonFile(path: string, value: unknown): void
{
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8')
}
