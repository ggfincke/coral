// src/agent/undo.ts
// reverse the last agent turn & its file edits

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { toErrorMessage } from '../utils/errors.js'
import { checkWorkspacePath } from '../tools/path-policy.js'
import type { UndoFileChange } from '../types/undo.js'

interface NetChange
{
  path: string
  before: string | null
  after: string
}

interface ReplayOptions
{
  cwd: string
}

interface ReplayChange extends NetChange
{
  resolvedPath: string
}

interface RollbackChange
{
  path: string
  restore: string | null
}

function mergeFileChanges(changes: UndoFileChange[]): NetChange[]
{
  const byPath = new Map<string, NetChange>()

  for (const change of changes)
  {
    const current = byPath.get(change.path)
    if (current)
    {
      current.after = change.after
    }
    else
    {
      byPath.set(change.path, { ...change })
    }
  }

  return [...byPath.values()].filter((change) => change.before !== change.after)
}

async function readCurrentFile(path: string): Promise<{
  exists: boolean
  content: string
  error?: string
}>
{
  try
  {
    return { exists: true, content: await readFile(path, 'utf-8') }
  }
  catch (err)
  {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { exists: false, content: '' }
    return { exists: false, content: '', error: toErrorMessage(err) }
  }
}

async function validateReplayPaths(
  changes: NetChange[],
  options: ReplayOptions
): Promise<
  { ok: true; changes: ReplayChange[] } | { ok: false; error: string }
>
{
  const replayChanges: ReplayChange[] = []

  for (const change of changes)
  {
    const allowed = await checkWorkspacePath(options.cwd, change.path, false)
    if (!allowed.ok)
    {
      return {
        ok: false,
        error: allowed.error ?? `Cannot access ${change.path}`,
      }
    }
    replayChanges.push({ ...change, resolvedPath: allowed.path })
  }

  return { ok: true, changes: replayChanges }
}

async function preflightChanges(
  changes: ReplayChange[],
  direction: 'undo' | 'redo'
): Promise<string | null>
{
  for (const change of changes)
  {
    const expected = direction === 'undo' ? change.after : change.before
    const current = await readCurrentFile(change.resolvedPath)
    if (current.error)
    {
      return `Cannot read ${change.resolvedPath}: ${current.error}`
    }
    if (!current.exists && expected === null)
    {
      continue
    }
    if (!current.exists)
    {
      return `Cannot ${direction} ${change.resolvedPath}: file is missing`
    }
    if (current.content !== expected)
    {
      return `Cannot ${direction} ${change.resolvedPath}: file changed outside Coral`
    }
  }

  return null
}

async function applyChanges(
  changes: ReplayChange[],
  contentFor: (change: ReplayChange) => string | null
): Promise<{ ok: true; files: number } | { ok: false; error: string }>
{
  let files = 0
  const rollback: RollbackChange[] = []
  try
  {
    for (const change of changes)
    {
      const previous = await readCurrentFile(change.resolvedPath)
      if (previous.error)
      {
        throw new Error(`Cannot read ${change.resolvedPath}: ${previous.error}`)
      }

      rollback.push({
        path: change.resolvedPath,
        restore: previous.exists ? previous.content : null,
      })

      const content = contentFor(change)
      if (content === null)
      {
        await rm(change.resolvedPath, { force: true })
      }
      else
      {
        await mkdir(dirname(change.resolvedPath), { recursive: true })
        await writeFile(change.resolvedPath, content, 'utf-8')
      }
      files++
    }
  }
  catch (err)
  {
    const rollbackError = await rollbackAppliedChanges(rollback)
    if (rollbackError)
    {
      return {
        ok: false,
        error: `${toErrorMessage(err)}; rollback failed: ${rollbackError}`,
      }
    }
    return { ok: false, error: toErrorMessage(err) }
  }

  return { ok: true, files }
}

async function rollbackAppliedChanges(
  changes: RollbackChange[]
): Promise<string | null>
{
  let firstError: string | null = null
  for (const change of changes.reverse())
  {
    try
    {
      if (change.restore === null)
      {
        await rm(change.path, { force: true })
      }
      else
      {
        await mkdir(dirname(change.path), { recursive: true })
        await writeFile(change.path, change.restore, 'utf-8')
      }
    }
    catch (err)
    {
      firstError ??= toErrorMessage(err)
    }
  }

  return firstError
}

export async function revertFileChanges(
  changes: UndoFileChange[],
  options: ReplayOptions
): Promise<{ ok: true; changedFiles: number } | { ok: false; error: string }>
{
  const netChanges = mergeFileChanges(changes)
  const validated = await validateReplayPaths(netChanges, options)
  if (!validated.ok) return validated

  const preflightError = await preflightChanges(validated.changes, 'undo')
  if (preflightError) return { ok: false, error: preflightError }

  const applied = await applyChanges(
    validated.changes,
    (change) => change.before
  )
  if (!applied.ok) return applied

  return { ok: true, changedFiles: applied.files }
}

export async function applyFileChanges(
  changes: UndoFileChange[],
  options: ReplayOptions
): Promise<{ ok: true; changedFiles: number } | { ok: false; error: string }>
{
  const netChanges = mergeFileChanges(changes)
  const validated = await validateReplayPaths(netChanges, options)
  if (!validated.ok) return validated

  const preflightError = await preflightChanges(validated.changes, 'redo')
  if (preflightError) return { ok: false, error: preflightError }

  const applied = await applyChanges(
    validated.changes,
    (change) => change.after
  )
  if (!applied.ok) return applied

  return { ok: true, changedFiles: applied.files }
}
