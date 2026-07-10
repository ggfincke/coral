// src/tools/path-policy.ts
// workspace path boundary checks for model-driven file tools

import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolvePath } from '../cwd.js'
import { isPathInsideProject } from '../shared/project-tree.js'

const WORKSPACE_PATH_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'grep',
  'glob',
  'list_files',
  'code_intel',
])

interface ResolvedToolPath
{
  path: string
  isInsideWorkspace: boolean
}

interface WorkspacePathCheck
{
  ok: boolean
  path: string
  error?: string
}

function toolPathArg(
  toolName: string,
  args: Record<string, unknown>
): string | undefined
{
  if (!WORKSPACE_PATH_TOOLS.has(toolName)) return undefined

  const path = typeof args.path === 'string' ? args.path : undefined
  if (toolName === 'read_file' || toolName === 'code_intel') return path
  return path ?? '.'
}

async function realpathIfExists(path: string): Promise<string | null>
{
  try
  {
    return await realpath(path)
  }
  catch
  {
    return null
  }
}

async function realpathNearestExisting(path: string): Promise<string | null>
{
  let current = path
  while (true)
  {
    const resolved = await realpathIfExists(current)
    if (resolved) return resolved

    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function resolveToolPath(
  cwd: string,
  rawPath: string | undefined,
  defaultPath = '.'
): ResolvedToolPath
{
  const path = resolvePath(rawPath ?? defaultPath, cwd)
  return {
    path,
    isInsideWorkspace: isPathInsideProject(cwd, path),
  }
}

export function requiresWorkspacePathApproval(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string
): boolean
{
  const rawPath = toolPathArg(toolName, args)
  if (rawPath === undefined) return false
  return !resolveToolPath(cwd, rawPath).isInsideWorkspace
}

export async function checkWorkspacePath(
  cwd: string,
  rawPath: string | undefined,
  allowOutsideWorkspace: boolean,
  defaultPath = '.'
): Promise<WorkspacePathCheck>
{
  const resolved = resolveToolPath(cwd, rawPath, defaultPath)
  if (allowOutsideWorkspace)
  {
    return { ok: true, path: resolved.path }
  }

  if (!resolved.isInsideWorkspace)
  {
    return {
      ok: false,
      path: resolved.path,
      error: `Access outside workspace requires approval: ${resolved.path}`,
    }
  }

  const [realCwd, realTarget] = await Promise.all([
    realpathIfExists(cwd),
    realpathNearestExisting(resolved.path),
  ])

  // fail closed: deny if realpath can't confirm the target stays in-workspace
  if (!realCwd || !realTarget || !isPathInsideProject(realCwd, realTarget))
  {
    return {
      ok: false,
      path: resolved.path,
      error: `Access outside workspace through symlink is not allowed: ${resolved.path}`,
    }
  }

  return { ok: true, path: resolved.path }
}
