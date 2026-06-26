// src/config/permissions.ts
// per-tool permission policies loaded from .coral.json

import { isPlainObject } from '../utils/guards.js'
import { loadProjectConfig, loadUserConfig } from './project-config.js'

// permission level for a given tool
export type PermissionPolicy =
  | 'always_allow'
  | 'require_approval'
  | 'always_deny'

// per-tool permission overrides — keys are tool names
export type ToolPermissions = Record<string, PermissionPolicy>

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
  git_switch: 'require_approval',
  git_push: 'require_approval',
  task: 'always_allow',
  todo_write: 'always_allow',
  write_file: 'require_approval',
  edit_file: 'require_approval',
  bash: 'require_approval',
}

// return a fresh copy so callers can use defaults w/o local config overrides
export function defaultToolPermissions(): ToolPermissions
{
  return { ...DEFAULT_TOOL_POLICIES }
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

function stricterPolicy(
  current: PermissionPolicy,
  project: PermissionPolicy
): PermissionPolicy
{
  const rank: Record<PermissionPolicy, number> = {
    always_allow: 0,
    require_approval: 1,
    always_deny: 2,
  }

  return rank[project] > rank[current] ? project : current
}

function applyProjectPermissions(
  base: ToolPermissions,
  project: ToolPermissions
): ToolPermissions
{
  const result = { ...base }

  for (const [toolName, policy] of Object.entries(project))
  {
    result[toolName] = stricterPolicy(
      result[toolName] ?? 'require_approval',
      policy
    )
  }

  return result
}

// resolve the effective permission config by loading:
// 1. built-in defaults
// 2. user-level ~/.coral.json (may loosen or tighten defaults)
// 3. project-level .coral.json in CWD (tightens only; never loosens)
export function resolvePermissions(cwd: string): ToolPermissions
{
  const userConfig = loadUserConfig()
  const projectConfig = loadProjectConfig(cwd)

  const userPerms = sanitizePermissions(userConfig.permissions)
  const projectPerms = sanitizePermissions(projectConfig.permissions)

  return applyProjectPermissions(
    { ...defaultToolPermissions(), ...userPerms },
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
