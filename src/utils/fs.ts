// src/utils/fs.ts
// small filesystem helpers

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function ensureParentDir(path: string): void
{
  mkdirSync(dirname(path), { recursive: true })
}
