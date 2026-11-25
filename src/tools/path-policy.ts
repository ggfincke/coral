// src/tools/path-policy.ts
// classify tool arguments that require workspace-path approval or touch protected paths

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import {
  realpathNearestEntry,
  resolveWorkspacePath,
} from '../shared/workspace-path.js'
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

// ~/.coral.json is read by loadUserConfig in src/config/project-config.ts;
// CORAL_HOME stays first for isInsideProtectedRoot
function protectedRoots(): string[]
{
  return [coralHomePath(), agentsHomePath(), join(homedir(), '.coral.json')]
}

function hasGitSegment(path: string): boolean
{
  return path.split(sep).some((segment) => segment.toLowerCase() === '.git')
}

// darwin and win32 volumes match names case-insensitively by default, so a
// case variant of a root that does not exist yet must still match it
function foldPathCase(path: string): string
{
  const folds = process.platform === 'darwin' || process.platform === 'win32'
  return folds ? path.toLowerCase() : path
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

// a missing path keeps its lexical form; its nearest parent would widen it
function realpathOr(path: string): Promise<string>
{
  return realpath(path).catch(() => path)
}

// lexical and link-resolved views both count, so a symlink to .git/config is
// judged by its real target; an unresolvable path fails closed as protected
async function isProtectedPath(path: string, cwd: string): Promise<boolean>
{
  const roots = protectedRoots()
  if (hasGitSegment(path) || isInsideProtectedRoot(path, cwd, roots))
    return true

  const realPath = await realpathNearestEntry(path)
  if (realPath === null) return true
  if (hasGitSegment(realPath)) return true
  const [realCwd, realRoots] = await Promise.all([
    realpathOr(cwd),
    Promise.all(roots.map(realpathOr)),
  ])
  return isInsideProtectedRoot(realPath, realCwd, realRoots)
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
