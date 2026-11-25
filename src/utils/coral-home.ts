// src/utils/coral-home.ts
// resolve Coral's local state directory

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// a relative override resolves against the home dir, never the launch dir,
// so a cloned repo cannot supply trusted state
function getCoralHome(): string
{
  const override = process.env.CORAL_HOME
  return override ? resolve(homedir(), override) : join(homedir(), '.coral')
}

export function coralHomePath(...segments: string[]): string
{
  return join(getCoralHome(), ...segments)
}
