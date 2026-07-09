// src/utils/fs.ts
// small filesystem helpers

import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function ensurePrivateDir(path: string): void
{
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(path, 0o700)
}

export function ensureParentDir(path: string): void
{
  ensurePrivateDir(dirname(path))
}
