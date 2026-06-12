// src/config/permissions.ts
// per-tool permission policies loaded from .coral.json

import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

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

// load & parse a single .coral.json file (returns empty config on missing/invalid)
function loadConfigFile(path: string): CoralConfig
{
  try
  {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    )
    {
      return {}
    }

    return parsed as CoralConfig
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
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
  {
    return {}
  }

  const result: ToolPermissions = {}

  for (const [key, value] of Object.entries(raw as Record<string, unknown>))
  {
    if (isValidPolicy(value))
    {
      result[key] = value
    }
  }

  return result
}

// merge two permission maps — later values override earlier ones
function mergePermissions(
  base: ToolPermissions,
  override: ToolPermissions
): ToolPermissions
{
  return { ...base, ...override }
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

  return mergePermissions(
    mergePermissions(DEFAULT_TOOL_POLICIES, userPerms),
    projectPerms
  )
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
