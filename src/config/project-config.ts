// src/config/project-config.ts
// project-level Coral config loading

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readJsonObjectFile } from '../utils/json.js'

// top-level config schema for .coral.json
export interface CoralConfig
{
  permissions?: Record<string, unknown>
  retrieval?: {
    embeddingModel?: string
  }
  context?: {
    // optional num_ctx ceiling (tokens); env may override it
    maxNumCtx?: number
  }
  verify?: {
    // run a read-only self-check subagent after edit-producing turns
    enabled?: boolean
  }
}

const configCache = new Map<string, { mtimeMs: number; config: CoralConfig }>()

// load & parse a single config file
function loadCoralConfigFile(path: string): CoralConfig
{
  let mtimeMs: number
  try
  {
    mtimeMs = statSync(path).mtimeMs
  }
  catch
  {
    return {}
  }

  const cached = configCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs) return cached.config

  const config = (readJsonObjectFile(path) ?? {}) as CoralConfig
  configCache.set(path, { mtimeMs, config })
  return config
}

// load the user-level ~/.coral.json config
export function loadUserConfig(): CoralConfig
{
  return loadCoralConfigFile(join(homedir(), '.coral.json'))
}

// load the project-level .coral.json config
export function loadProjectConfig(cwd: string): CoralConfig
{
  return loadCoralConfigFile(resolve(cwd, '.coral.json'))
}
