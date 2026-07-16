// src/config/project-config.ts
// project-level Coral config loading

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readJsonObjectFile } from '../utils/json.js'

interface SharedCoralConfig
{
  permissions?: Record<string, unknown>
}

export interface UserCoralConfig extends SharedCoralConfig
{
  mcp?: unknown
}

export interface ProjectCoralConfig extends SharedCoralConfig
{
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

interface CachedConfig
{
  mtimeMs: number
  config: Record<string, unknown>
}

const configCache = new Map<string, CachedConfig>()

// load & parse a single config file
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
  if (config.permissions !== undefined)
  {
    result.permissions = config.permissions as Record<string, unknown>
  }
  if (config.mcp !== undefined) result.mcp = config.mcp
  return result
}

// load the project-level .coral.json config
export function loadProjectConfig(cwd: string): ProjectCoralConfig
{
  const config = loadCoralConfigFile(resolve(cwd, '.coral.json'))
  const result: ProjectCoralConfig = {}
  if (config.permissions !== undefined)
  {
    result.permissions = config.permissions as Record<string, unknown>
  }
  if (config.retrieval !== undefined)
  {
    result.retrieval = config.retrieval as ProjectCoralConfig['retrieval']
  }
  if (config.context !== undefined)
  {
    result.context = config.context as ProjectCoralConfig['context']
  }
  if (config.verify !== undefined)
  {
    result.verify = config.verify as ProjectCoralConfig['verify']
  }
  return result
}
