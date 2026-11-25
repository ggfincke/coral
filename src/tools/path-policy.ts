// src/tools/path-policy.ts
// classify tool arguments that require workspace-path approval

import { resolveWorkspacePath } from '../shared/workspace-path.js'
import { getBuiltInToolRegistration } from './catalog.js'

function toolPathArgs(
  toolName: string,
  args: Record<string, unknown>
): string[]
{
  const rule = getBuiltInToolRegistration(toolName)?.workspacePath
  if (!rule) return []

  const value = args[rule.argument]
  if (typeof value === 'string') return [value]
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string')
  return rule.defaultPath === undefined ? [] : [rule.defaultPath]
}

export function requiresWorkspacePathApproval(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string
): boolean
{
  return toolPathArgs(toolName, args).some(
    (rawPath) => !resolveWorkspacePath(cwd, rawPath).isInsideWorkspace
  )
}
