// src/utils/agents-home.ts
// resolve the shared Agents directory

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// a relative override resolves against the home dir, never the launch dir,
// so a cloned repo cannot supply trusted state
function getAgentsHome(): string
{
  const override = process.env.AGENTS_HOME
  return override ? resolve(homedir(), override) : join(homedir(), '.agents')
}

export function agentsHomePath(...segments: string[]): string
{
  return join(getAgentsHome(), ...segments)
}
