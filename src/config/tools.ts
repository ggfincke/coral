// src/config/tools.ts
// user and project tool profile resolution

import { loadProjectConfig, loadUserConfig } from './project-config.js'
import { isPlainObject } from '../utils/guards.js'
import { getBuiltInToolRegistration } from '../tools/catalog.js'

export interface ToolsConfig
{
  disabled: readonly string[]
  localTask: boolean
}

// ignore malformed fields and names outside the built-in tool registry
export function resolveToolsConfig(cwd: string): ToolsConfig
{
  const user = loadUserConfig().tools
  const project = loadProjectConfig(cwd).tools
  const disabled = new Set<string>()
  let localTask = false
  for (const raw of [user, project])
  {
    if (!isPlainObject(raw)) continue
    if (Array.isArray(raw.disabled))
    {
      for (const name of raw.disabled)
      {
        if (typeof name === 'string' && getBuiltInToolRegistration(name))
        {
          disabled.add(name)
        }
      }
    }
    if (typeof raw.localTask === 'boolean') localTask = raw.localTask
  }
  return { disabled: [...disabled], localTask }
}
