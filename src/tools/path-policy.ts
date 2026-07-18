// src/tools/path-policy.ts
// classify tool arguments that require workspace-path approval

import { resolveWorkspacePath } from '../shared/workspace-path.js'
import { getBuiltInToolRegistration } from './catalog.js'

function toolPathArg(
  toolName: string,
  args: Record<string, unknown>
): string | undefined
{
  const rule = getBuiltInToolRegistration(toolName)?.workspacePath
  if (!rule) return undefined

  const path =
    typeof args[rule.argument] === 'string'
      ? (args[rule.argument] as string)
      : undefined
  return path ?? rule.defaultPath
}

export function requiresWorkspacePathApproval(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string
): boolean
{
  const rawPath = toolPathArg(toolName, args)
  if (rawPath === undefined) return false
  return !resolveWorkspacePath(cwd, rawPath).isInsideWorkspace
}
