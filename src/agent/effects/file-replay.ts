// src/agent/effects/file-replay.ts
// reverse or reapply one turn's file edits

import { mkdir, open, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { toErrorMessage } from '../../utils/errors.js'
import {
  EXCLUSIVE_CREATE_FLAGS,
  openRegularFileForWrite,
  overwriteRegularFile,
  readOptionalPreviousTextFile,
  replaceOpenedFile,
} from '../../utils/file-read.js'
import { checkWorkspacePath } from '../../shared/workspace-path.js'
import type { UndoFileChange } from '../../types/undo.js'

interface NetChange
{
  path: string
  before: string | null
  after: string
}

interface ReplayOptions
{
  cwd: string
  signal?: AbortSignal
}

interface ReplayChange extends NetChange
{
  resolvedPath: string
  // workspace root later opens must stay inside
  root?: string
}

interface RollbackChange
{
  path: string
  root?: string
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

// snapshots are strict UTF-8 under the text read limit, so a lossy, oversized,
// or non-regular current file is an error; rewriting it would lose its bytes
async function readCurrentFile(
  change: ReplayChange,
  signal?: AbortSignal
): Promise<{
  exists: boolean
  content: string
  error?: string
}>
{
  const read = await readOptionalPreviousTextFile(change.resolvedPath, {
    root: change.root,
    signal,
  })
  if (!read.ok) return { exists: false, content: '', error: read.message }
  if (read.lossy)
  {
    return { exists: true, content: '', error: 'file is not valid UTF-8' }
  }
  return { exists: read.existed, content: read.content }
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
    options.signal?.throwIfAborted()
    const allowed = await checkWorkspacePath(options.cwd, change.path, false)
    options.signal?.throwIfAborted()
    if (!allowed.ok)
    {
      return {
        ok: false,
        error: allowed.error ?? `Cannot access ${change.path}`,
      }
    }
    replayChanges.push({
      ...change,
      resolvedPath: allowed.path,
      root: allowed.root,
    })
  }

  return { ok: true, changes: replayChanges }
}

async function preflightChanges(
  changes: ReplayChange[],
  direction: 'undo' | 'redo',
  signal?: AbortSignal
): Promise<string | null>
{
  for (const change of changes)
  {
    signal?.throwIfAborted()
    const expected = direction === 'undo' ? change.after : change.before
    const current = await readCurrentFile(change, signal)
    signal?.throwIfAborted()
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
  contentFor: (change: ReplayChange) => string | null,
  signal?: AbortSignal
): Promise<{ ok: true; files: number } | { ok: false; error: string }>
{
  let files = 0
  const rollback: RollbackChange[] = []
  try
  {
    for (const change of changes)
    {
      signal?.throwIfAborted()
      const previous = await readCurrentFile(change, signal)
      signal?.throwIfAborted()
      if (previous.error)
      {
        throw new Error(`Cannot read ${change.resolvedPath}: ${previous.error}`)
      }

      // record rollback only once the target is open, so a refused open
      // (swapped link, concurrent create) never rolls back someone else's file
      const entry: RollbackChange = {
        path: change.resolvedPath,
        root: change.root,
        restore: previous.exists ? previous.content : null,
      }
      const content = contentFor(change)
      if (content === null)
      {
        rollback.push(entry)
        await rm(change.resolvedPath, { force: true })
      }
      else if (previous.exists)
      {
        const file = await openRegularFileForWrite(change.resolvedPath, {
          root: change.root,
          signal,
        })
        rollback.push(entry)
        await replaceOpenedFile(file, content, signal)
      }
      else
      {
        await mkdir(dirname(change.resolvedPath), { recursive: true })
        signal?.throwIfAborted()
        const handle = await open(change.resolvedPath, EXCLUSIVE_CREATE_FLAGS)
        rollback.push(entry)
        try
        {
          await handle.writeFile(content, { encoding: 'utf-8', signal })
        }
        finally
        {
          await handle.close()
        }
      }
      signal?.throwIfAborted()
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

// put back a file's old text through the same confined write paths, creating
// it again when the failed replay had removed it
async function restoreFile(
  change: RollbackChange,
  restore: string
): Promise<void>
{
  try
  {
    await overwriteRegularFile(change.path, restore, { root: change.root })
  }
  catch (err)
  {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    await mkdir(dirname(change.path), { recursive: true })
    await writeFile(change.path, restore, {
      encoding: 'utf-8',
      flag: EXCLUSIVE_CREATE_FLAGS,
    })
  }
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
        await restoreFile(change, change.restore)
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
  try
  {
    options.signal?.throwIfAborted()
    const netChanges = mergeFileChanges(changes)
    const validated = await validateReplayPaths(netChanges, options)
    if (!validated.ok) return validated

    const preflightError = await preflightChanges(
      validated.changes,
      'undo',
      options.signal
    )
    if (preflightError) return { ok: false, error: preflightError }

    const applied = await applyChanges(
      validated.changes,
      (change) => change.before,
      options.signal
    )
    if (!applied.ok) return applied

    return { ok: true, changedFiles: applied.files }
  }
  catch (error)
  {
    return { ok: false, error: toErrorMessage(error) }
  }
}

export async function applyFileChanges(
  changes: UndoFileChange[],
  options: ReplayOptions
): Promise<{ ok: true; changedFiles: number } | { ok: false; error: string }>
{
  try
  {
    options.signal?.throwIfAborted()
    const netChanges = mergeFileChanges(changes)
    const validated = await validateReplayPaths(netChanges, options)
    if (!validated.ok) return validated

    const preflightError = await preflightChanges(
      validated.changes,
      'redo',
      options.signal
    )
    if (preflightError) return { ok: false, error: preflightError }

    const applied = await applyChanges(
      validated.changes,
      (change) => change.after,
      options.signal
    )
    if (!applied.ok) return applied

    return { ok: true, changedFiles: applied.files }
  }
  catch (error)
  {
    return { ok: false, error: toErrorMessage(error) }
  }
}
