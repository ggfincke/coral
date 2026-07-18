// src/config/project-config.ts
// raw user & project Coral config loading

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readJsonObjectFile } from '../utils/json.js'

interface SharedCoralConfig
{
  permissions?: unknown
}

export interface UserCoralConfig extends SharedCoralConfig
{
  mcp?: unknown
}

export interface ProjectCoralConfig extends SharedCoralConfig
{
  retrieval?: unknown
  context?: unknown
  verify?: unknown
}

interface CachedConfig
{
  mtimeMs: number
  config: Record<string, unknown>
}

const configCache = new Map<string, CachedConfig>()

// load one JSON object w/o interpreting its section values
function loadCoralConfigFile(path: string): Record<string, unknown>
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

  const config = readJsonObjectFile(path) ?? {}
  configCache.set(path, { mtimeMs, config })
  return config
}

// load the user-level ~/.coral.json config
export function loadUserConfig(): UserCoralConfig
{
  const config = loadCoralConfigFile(join(homedir(), '.coral.json'))
  const result: UserCoralConfig = {}
  if (config.permissions !== undefined) result.permissions = config.permissions
  if (config.mcp !== undefined) result.mcp = config.mcp
  return result
}

// load the project-level .coral.json config
export function loadProjectConfig(cwd: string): ProjectCoralConfig
{
  const config = loadCoralConfigFile(resolve(cwd, '.coral.json'))
  const result: ProjectCoralConfig = {}
  if (config.permissions !== undefined) result.permissions = config.permissions
  if (config.retrieval !== undefined) result.retrieval = config.retrieval
  if (config.context !== undefined) result.context = config.context
  if (config.verify !== undefined) result.verify = config.verify
  return result
}
