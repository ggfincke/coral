// src/shared/workspace-path.ts
// workspace containment and symlink checks

import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolvePath } from '../cwd.js'
import { isPathInsideProject } from './project-tree.js'

export interface ResolvedWorkspacePath
{
  path: string
  isInsideWorkspace: boolean
}

export interface WorkspacePathCheck
{
  ok: boolean
  path: string
  error?: string
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

export function resolveWorkspacePath(
  cwd: string,
  rawPath: string | undefined,
  defaultPath = '.'
): ResolvedWorkspacePath
{
  const path = resolvePath(rawPath ?? defaultPath, cwd)
  return {
    path,
    isInsideWorkspace: isPathInsideProject(cwd, path),
  }
}

export async function checkWorkspacePath(
  cwd: string,
  rawPath: string | undefined,
  allowOutsideWorkspace: boolean,
  defaultPath = '.'
): Promise<WorkspacePathCheck>
{
  const resolved = resolveWorkspacePath(cwd, rawPath, defaultPath)
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

  // fail closed when real paths cannot prove the target remains in the workspace
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
