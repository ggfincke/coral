// src/config/permissions.ts
// per-tool permission policy resolution

import { isPlainObject } from '../utils/guards.js'
import {
  builtInToolRegistrations,
  UNKNOWN_TOOL_DEFAULT_POLICY,
  type DefaultToolPolicy,
} from '../tools/catalog.js'
import { loadProjectConfig, loadUserConfig } from './project-config.js'

export type PermissionPolicy = DefaultToolPolicy

export type ToolPermissions = Record<string, PermissionPolicy>

function permissionRecord(
  entries: Iterable<readonly [string, PermissionPolicy]> = []
): ToolPermissions
{
  const result = Object.create(null) as ToolPermissions
  for (const [name, policy] of entries) result[name] = policy
  return result
}

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

// return a fresh copy so callers can merge local overrides safely
export function defaultToolPermissions(): ToolPermissions
{
  return mergePermissions(DEFAULT_TOOL_POLICIES)
}

function isValidPolicy(value: unknown): value is PermissionPolicy
{
  return (
    value === 'always_allow' ||
    value === 'require_approval' ||
    value === 'always_deny'
  )
}

// keep only valid policy entries from untrusted config
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

// combine built-in, user, and project policies while keeping project policy stricter
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

// resolve one tool policy and fail closed for unknown tools
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
