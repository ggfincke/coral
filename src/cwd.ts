// src/cwd.ts
// module-level CWD state — single source of truth for the working directory

import { resolve, isAbsolute } from 'node:path'

// current working directory — initialized to process.cwd(), updated by setCwd()
let cwd = process.cwd()

// get the current working directory
export function getCwd(): string
{
  return cwd
}

// set the working directory (absolute path)
export function setCwd(dir: string): void
{
  cwd = resolve(dir)
}

// resolve a path against a working directory
// absolute paths pass through unchanged, relative paths use the provided cwd
export function resolvePath(p: string, baseCwd = cwd): string
{
  if (isAbsolute(p)) return p
  return resolve(baseCwd, p)
}
