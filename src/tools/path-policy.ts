// src/tools/path-policy.ts
// classify tool arguments that require workspace-path approval or touch protected paths

import type { BigIntStats } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { resolveWorkspacePath } from '../shared/workspace-path.js'
import { agentsHomePath } from '../utils/agents-home.js'
import { coralHomePath } from '../utils/coral-home.js'
import { tryParseJson } from '../utils/json.js'
import { isPathInsideProject } from '../utils/path-containment.js'
import { getBuiltInToolRegistration } from './catalog.js'

// file tools whose writes can turn edit authority into standing shell
// authority when aimed at git internals or Coral's own control files
const PROTECTED_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
])

// a JSON-string array is read the way validateToolArgs coerces it, so the
// gate sees the same paths the tool later receives
function toolPathArgs(
  toolName: string,
  args: Record<string, unknown>
): string[]
{
  const rule = getBuiltInToolRegistration(toolName)?.workspacePath
  if (!rule) return []

  let value = args[rule.argument]
  if (rule.argument === 'paths' && typeof value === 'string')
  {
    const parsed = tryParseJson(value)
    if (Array.isArray(parsed)) value = parsed
  }
  if (typeof value === 'string') return [value]
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string')
  return []
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

// ~/.coral.json is read by loadUserConfig in src/config/project-config.ts;
// CORAL_HOME stays first for isInsideProtectedRoot
function protectedRoots(): string[]
{
  return [coralHomePath(), agentsHomePath(), join(homedir(), '.coral.json')]
}

// win32 drops trailing dots and spaces from each name, so `.coral.json.`
// opens `.coral.json`; a name made only of them is left alone
function foldWin32Segment(segment: string): string
{
  if (process.platform !== 'win32') return segment
  const trimmed = segment.replace(/[. ]+$/, '')
  return trimmed === '' ? segment : trimmed
}

function hasGitSegment(path: string): boolean
{
  return path
    .split(sep)
    .some((segment) => foldWin32Segment(segment).toLowerCase() === '.git')
}

// darwin and win32 volumes match names case-insensitively by default, so a
// case variant of a root that does not exist yet must still match it
function foldPathCase(path: string): string
{
  const folds = process.platform === 'darwin' || process.platform === 'win32'
  const trimmed = path.split(sep).map(foldWin32Segment).join(sep)
  return folds ? trimmed.toLowerCase() : trimmed
}

// a task worktree sits at CORAL_HOME/jobs/<id>/worktree (jobDirectory in
// src/jobs/store.ts) and keeps its own files writable; no other workspace
// nested in a protected root gets that carve-out
function isJobWorktree(coralHome: string, cwd: string): boolean
{
  const jobsRoot = join(coralHome, 'jobs')
  if (!isPathInsideProject(jobsRoot, cwd)) return false
  const segments = relative(jobsRoot, cwd).split(sep)
  return segments.length === 2 && segments[1] === 'worktree'
}

// roots[0] is CORAL_HOME, the only root that can hold a task worktree
function isInsideProtectedRoot(
  path: string,
  cwd: string,
  roots: readonly string[]
): boolean
{
  const [foldedPath, foldedCwd] = [foldPathCase(path), foldPathCase(cwd)]
  const foldedRoots = roots.map(foldPathCase)
  if (!foldedRoots.some((root) => isPathInsideProject(root, foldedPath)))
    return false
  return !(
    isJobWorktree(foldedRoots[0], foldedCwd) &&
    isPathInsideProject(foldedCwd, foldedPath)
  )
}

interface CanonicalPath
{
  // real path of the nearest existing entry at or above the path
  anchor: string
  // anchor joined with the missing tail
  path: string
}

function isAbsentEntry(err: unknown): boolean
{
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

// realpath of the nearest existing entry plus the missing tail, so a path that
// does not exist yet keeps its name under its real parent; a dangling link or
// unreadable entry yields null
async function canonicalPath(path: string): Promise<CanonicalPath | null>
{
  const tail: string[] = []
  let current = path
  while (true)
  {
    try
    {
      await lstat(current)
      break
    }
    catch (err)
    {
      if (!isAbsentEntry(err)) return null
    }
    const parent = dirname(current)
    if (parent === current) return null
    tail.unshift(basename(current))
    current = parent
  }
  const anchor = await realpath(current).catch(() => null)
  return anchor === null ? null : { anchor, path: join(anchor, ...tail) }
}

function sameEntry(
  left: BigIntStats | null,
  right: BigIntStats | null
): boolean
{
  return (
    left !== null &&
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino
  )
}

// macOS firmlinks (/System/Volumes/Data/Users/...) name the same directory as
// /Users/... without being links, so realpath can keep both spellings; an
// ancestor of the target that is a root's anchor by device and inode rebases
// the target onto that root's spelling
async function aliasSpellings(
  target: CanonicalPath,
  roots: readonly (CanonicalPath | null)[]
): Promise<string[]>
{
  const identity = (path: string) =>
    stat(path, { bigint: true }).catch(() => null)
  const rootIds = await Promise.all(
    roots.map((root) => (root ? identity(root.anchor) : null))
  )
  const spellings: string[] = []
  for (let dir = target.anchor; ; dir = dirname(dir))
  {
    const dirId = await identity(dir)
    roots.forEach((root, index) =>
    {
      if (root && root.anchor !== dir && sameEntry(dirId, rootIds[index]!))
        spellings.push(join(root.anchor, relative(dir, target.path)))
    })
    if (dirname(dir) === dir) return spellings
  }
}

// lexical and canonical views both count, so a symlink to .git/config is
// judged by its real target and a root that does not exist yet still matches
// through a linked or firmlinked ancestor; an unresolvable path fails closed
async function isProtectedPath(path: string, cwd: string): Promise<boolean>
{
  const roots = protectedRoots()
  if (hasGitSegment(path) || isInsideProtectedRoot(path, cwd, roots))
    return true

  const [target, realCwd, realRoots] = await Promise.all([
    canonicalPath(path),
    canonicalPath(cwd),
    Promise.all(roots.map(canonicalPath)),
  ])
  if (target === null || hasGitSegment(target.path)) return true

  const rootPaths = realRoots.map((root, index) => root?.path ?? roots[index]!)
  const cwdPath = realCwd?.path ?? cwd
  const spellings = [target.path, ...(await aliasSpellings(target, realRoots))]
  return spellings.some((spelling) =>
    isInsideProtectedRoot(spelling, cwdPath, rootPaths)
  )
}

// true when a file-tool write targets git internals, CORAL_HOME, AGENTS_HOME,
// or ~/.coral.json; such calls always prompt & no grant or auto mode covers them
export async function touchesProtectedPath(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string
): Promise<boolean>
{
  if (!PROTECTED_WRITE_TOOLS.has(toolName)) return false
  const checks = toolPathArgs(toolName, args).map((rawPath) =>
    isProtectedPath(resolveWorkspacePath(cwd, rawPath).path, cwd)
  )
  return (await Promise.all(checks)).some(Boolean)
}
