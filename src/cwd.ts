// src/cwd.ts
// working-directory state and path resolution

import { resolve, isAbsolute } from 'node:path'

let cwd = process.cwd()

export function getCwd(): string
{
  return cwd
}

// update the active working directory
export function setCwd(dir: string): void
{
  cwd = resolve(dir)
}

// resolve relative paths against the active or supplied working directory
export function resolvePath(p: string, baseCwd = cwd): string
{
  if (isAbsolute(p)) return p
  return resolve(baseCwd, p)
}
