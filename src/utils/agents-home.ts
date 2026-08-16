// src/utils/agents-home.ts
// resolve the shared Agents directory (same tree Codex reads)

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function getAgentsHome(): string
{
  const override = process.env.AGENTS_HOME
  return override ? resolve(override) : join(homedir(), '.agents')
}

export function agentsHomePath(...segments: string[]): string
{
  return join(getAgentsHome(), ...segments)
}
