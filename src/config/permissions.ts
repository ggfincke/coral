// src/config/permissions.ts
// per-tool permission policies loaded from .coral.json

import { readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { isPlainObject } from '../utils/guards.js'

// permission level for a given tool
export type PermissionPolicy =
  | 'always_allow'
  | 'require_approval'
  | 'always_deny'

// per-tool permission overrides — keys are tool names
export type ToolPermissions = Record<string, PermissionPolicy>

// top-level config schema for .coral.json
export interface CoralConfig
{
  // per-tool permission policies
  permissions?: ToolPermissions
  retrieval?: {
    embeddingModel?: string
  }
  context?: {
    // optional num_ctx ceiling (tokens) — overrides the memory-derived default
    maxNumCtx?: number
  }
  verify?: {
    // run a read-only self-check subagent after edit-producing turns
    enabled?: boolean
  }
}

// default policies when no config is present
const DEFAULT_TOOL_POLICIES: ToolPermissions = {
  read_file: 'always_allow',
  grep: 'always_allow',
  glob: 'always_allow',
  list_files: 'always_allow',
  git_status: 'always_allow',
  git_diff: 'always_allow',
  git_log: 'always_allow',
  search_code: 'always_allow',
  git_add: 'require_approval',
  git_commit: 'require_approval',
  git_push: 'require_approval',
  task: 'always_allow',
  todo_write: 'always_allow',
  write_file: 'require_approval',
  edit_file: 'require_approval',
  bash: 'require_approval',
}

// parse-once cache for .coral.json, keyed on path + mtime so live edits
// (e.g. between search_code calls) are still picked up without re-parsing
const configCache = new Map<string, { mtimeMs: number; config: CoralConfig }>()

// load & parse a single .coral.json file (returns empty config on missing/invalid)
function loadConfigFile(path: string): CoralConfig
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

  const config = parseConfigFile(path)
  configCache.set(path, { mtimeMs, config })
  return config
}

// read & parse a config file body (empty config on read/parse failure)
function parseConfigFile(path: string): CoralConfig
{
  try
  {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return isPlainObject(parsed) ? (parsed as CoralConfig) : {}
  }
  catch
  {
    return {}
  }
}

// validate that a permission value is one of the allowed policies
function isValidPolicy(value: unknown): value is PermissionPolicy
{
  return (
    value === 'always_allow' ||
    value === 'require_approval' ||
    value === 'always_deny'
  )
}

// sanitize permissions object — strip invalid entries
function sanitizePermissions(raw: unknown): ToolPermissions
{
  if (!isPlainObject(raw))
  {
    return {}
  }

  const result: ToolPermissions = {}

  for (const [key, value] of Object.entries(raw))
  {
    if (isValidPolicy(value))
    {
      result[key] = value
    }
  }

  return result
}

// resolve the effective permission config by loading:
// 1. built-in defaults
// 2. user-level ~/.coral.json (overrides defaults)
// 3. project-level .coral.json in CWD (overrides user-level)
export function resolvePermissions(cwd: string): ToolPermissions
{
  const userConfig = loadConfigFile(join(homedir(), '.coral.json'))
  const projectConfig = loadConfigFile(resolve(cwd, '.coral.json'))

  const userPerms = sanitizePermissions(userConfig.permissions)
  const projectPerms = sanitizePermissions(projectConfig.permissions)

  return { ...DEFAULT_TOOL_POLICIES, ...userPerms, ...projectPerms }
}

// get the policy for a specific tool — falls back to require_approval for unknown tools
export function getToolPolicy(
  permissions: ToolPermissions,
  toolName: string
): PermissionPolicy
{
  return permissions[toolName] ?? 'require_approval'
}

// load the full coral config from project-level .coral.json
// used by other modules (e.g., context injection) that need non-permission config
export function loadProjectConfig(cwd: string): CoralConfig
{
  return loadConfigFile(resolve(cwd, '.coral.json'))
}
