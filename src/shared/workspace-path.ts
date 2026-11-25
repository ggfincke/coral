// src/shared/workspace-path.ts
// workspace containment and symlink checks

import { lstat, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolvePath } from '../cwd.js'
import { isPathInsideProject } from '../utils/path-containment.js'

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
  // set when the path was confined to the workspace; later opens pass it as
  // their root so a link swapped in after this check fails closed
  root?: string
}

// a leading ~ is never shell-expanded here, so it would name a literal dir
const HOME_SHORTHAND = /^~(?:\/|$)/

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

function isAbsentEntry(err: unknown): boolean
{
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

// real path of the nearest entry at or above path; lstat counts a dangling
// link as present, so it (or any error but an absent entry) yields null and
// callers fail closed instead of checking a parent
export async function realpathNearestEntry(
  path: string
): Promise<string | null>
{
  let current = path
  while (true)
  {
    try
    {
      await lstat(current)
      // the entry exists; a dangling link fails realpath & stays null
      return await realpathIfExists(current)
    }
    catch (err)
    {
      if (!isAbsentEntry(err)) return null
    }

    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function resolveWorkspacePath(
  cwd: string,
  rawPath: string | undefined
): ResolvedWorkspacePath
{
  const path = resolvePath(rawPath ?? '.', cwd)
  return {
    path,
    isInsideWorkspace: isPathInsideProject(cwd, path),
  }
}

export async function checkWorkspacePath(
  cwd: string,
  rawPath: string | undefined,
  allowOutsideWorkspace: boolean
): Promise<WorkspacePathCheck>
{
  const resolved = resolveWorkspacePath(cwd, rawPath)
  if (rawPath !== undefined && HOME_SHORTHAND.test(rawPath))
  {
    return {
      ok: false,
      path: resolved.path,
      error: `Paths starting with ~ are not expanded; use an absolute path: ${rawPath}`,
    }
  }

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
    realpathNearestEntry(resolved.path),
  ])

  // fail closed when real paths cannot prove the target remains in the
  // workspace, including a dangling link whose target a write would create
  if (!realCwd || !realTarget)
  {
    return {
      ok: false,
      path: resolved.path,
      error: `Cannot resolve ${resolved.path} inside the workspace (dangling symlink or unreadable path)`,
    }
  }
  if (!isPathInsideProject(realCwd, realTarget))
  {
    return {
      ok: false,
      path: resolved.path,
      error: `Access outside workspace through symlink is not allowed: ${resolved.path}`,
    }
  }

  return { ok: true, path: resolved.path, root: cwd }
}
