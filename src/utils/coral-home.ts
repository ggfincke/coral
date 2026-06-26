// src/utils/coral-home.ts
// resolve Coral's local state directory

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function getCoralHome(): string
{
  const override = process.env.CORAL_HOME
  return override ? resolve(override) : join(homedir(), '.coral')
}

export function coralHomePath(...segments: string[]): string
{
  return join(getCoralHome(), ...segments)
}
