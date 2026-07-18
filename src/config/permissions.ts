// src/config/permissions.ts
// per-tool permission policies loaded from .coral.json

import { isPlainObject } from '../utils/guards.js'
import {
  builtInToolRegistrations,
  UNKNOWN_TOOL_DEFAULT_POLICY,
  type DefaultToolPolicy,
} from '../tools/catalog.js'
import { loadProjectConfig, loadUserConfig } from './project-config.js'

// permission level for a given tool
export type PermissionPolicy = DefaultToolPolicy

// per-tool permission overrides — keys are tool names
export type ToolPermissions = Record<string, PermissionPolicy>

function permissionRecord(
  entries: Iterable<readonly [string, PermissionPolicy]> = []
): ToolPermissions
{
  const result = Object.create(null) as ToolPermissions
  for (const [name, policy] of entries) result[name] = policy
  return result
}

// default policies when no config is present
const DEFAULT_TOOL_POLICIES: ToolPermissions = Object.freeze(
  permissionRecord(
    builtInToolRegistrations.map((registration) => [
      registration.name,
      registration.defaultPolicy,
    ])
  )
)

function mergePermissions(
  ...sources: readonly ToolPermissions[]
): ToolPermissions
{
  const result = permissionRecord()
  for (const source of sources)
  {
    for (const [name, policy] of Object.entries(source))
    {
      result[name] = policy
    }
  }
  return result
}

// return a fresh copy so callers can use defaults w/o local config overrides
export function defaultToolPermissions(): ToolPermissions
{
  return mergePermissions(DEFAULT_TOOL_POLICIES)
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
    return permissionRecord()
  }

  const result = permissionRecord()

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
  const result = mergePermissions(base)

  for (const [toolName, policy] of Object.entries(project))
  {
    result[toolName] = stricterPolicy(
      result[toolName] ?? UNKNOWN_TOOL_DEFAULT_POLICY,
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
    mergePermissions(defaultToolPermissions(), userPerms),
    projectPerms
  )
}

// get the policy for a specific tool — falls back to require_approval for unknown tools
export function getToolPolicy(
  permissions: ToolPermissions,
  toolName: string
): PermissionPolicy
{
  if (!Object.hasOwn(permissions, toolName))
  {
    return UNKNOWN_TOOL_DEFAULT_POLICY
  }
  const policy = permissions[toolName]
  return isValidPolicy(policy) ? policy : UNKNOWN_TOOL_DEFAULT_POLICY
}
