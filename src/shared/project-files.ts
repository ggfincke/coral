// src/shared/project-files.ts
// git-aware project file discovery

import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runGitCommand } from '../utils/git.js'
import { createIgnoredEntrySet } from './ignored-entries.js'
import {
  compareProjectTreeEntries,
  formatProjectPath,
  shouldIncludeProjectTreeEntry,
} from './project-tree.js'

const GIT_FILE_LIST_MAX_BUFFER = 16 * 1024 * 1024

// output-style directory names that often hold real tracked source; tracked
// paths under them stay listed, while deps and caches stay filtered
const TRACKED_SOURCE_DIR_NAMES = new Set([
  'build',
  'dist',
  'target',
  'coverage',
])

export interface ProjectFile
{
  path: string
  absolutePath: string
  size: number
  mtimeMs: number
  ctimeMs: number
}

export interface ProjectFileWalkerOptions
{
  maxFiles?: number
  maxFileBytes?: number
  ignoredEntries?: Iterable<string>
  includePath?: (path: string) => boolean
  signal?: AbortSignal
}

function hasIgnoredPathSegment(path: string, ignored: Set<string>): boolean
{
  return path.split('/').some((segment) => ignored.has(segment))
}

async function statProjectFile(
  cwd: string,
  path: string,
  options: ProjectFileWalkerOptions
): Promise<ProjectFile | null>
{
  options.signal?.throwIfAborted()
  const absolutePath = join(cwd, path)

  let info
  try
  {
    // reject symlinks so only real files enter the index
    info = await lstat(absolutePath)
    options.signal?.throwIfAborted()
    if (info.isSymbolicLink()) return null
  }
  catch
  {
    options.signal?.throwIfAborted()
    return null
  }

  if (!info.isFile()) return null
  if (options.maxFileBytes !== undefined && info.size > options.maxFileBytes)
  {
    return null
  }

  return {
    path,
    absolutePath,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  }
}

interface GitProjectPath
{
  path: string
  // tracked paths may sit under build/, dist/, target/, or coverage/
  tracked: boolean
}

async function listGitPaths(
  cwd: string,
  args: string[],
  signal?: AbortSignal
): Promise<string[] | null>
{
  const result = await runGitCommand(['ls-files', ...args, '-z'], cwd, {
    maxBuffer: GIT_FILE_LIST_MAX_BUFFER,
    signal,
  })
  if (result.error) return null
  return result.output.split('\0').filter(Boolean)
}

// keep git's ignore-aware path list deterministic, or fall back outside a repo
async function listGitProjectPaths(
  cwd: string,
  signal?: AbortSignal
): Promise<GitProjectPath[] | null>
{
  const [tracked, untracked] = await Promise.all([
    listGitPaths(cwd, ['--cached'], signal),
    listGitPaths(cwd, ['--others', '--exclude-standard'], signal),
  ])
  if (!tracked || !untracked) return null

  // sort by code units so ordering does not depend on the host locale
  return [
    ...tracked.map((path) => ({ path, tracked: true })),
    ...untracked.map((path) => ({ path, tracked: false })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

async function* iterateGitProjectFiles(
  cwd: string,
  paths: GitProjectPath[],
  options: ProjectFileWalkerOptions
): AsyncGenerator<ProjectFile>
{
  const ignored = createIgnoredEntrySet(options.ignoredEntries)
  const trackedIgnored = new Set(
    [...ignored].filter((name) => !TRACKED_SOURCE_DIR_NAMES.has(name))
  )
  // a caller's own extras still apply to tracked paths
  for (const name of options.ignoredEntries ?? []) trackedIgnored.add(name)
  let yielded = 0

  for (const { path, tracked } of paths)
  {
    options.signal?.throwIfAborted()
    if (options.maxFiles !== undefined && yielded >= options.maxFiles) return
    if (hasIgnoredPathSegment(path, tracked ? trackedIgnored : ignored))
    {
      continue
    }
    if (options.includePath && !options.includePath(path)) continue

    const file = await statProjectFile(cwd, path, options)
    if (file)
    {
      yield file
      yielded++
    }
  }
}

async function* iterateFallbackProjectFiles(
  cwd: string,
  options: ProjectFileWalkerOptions
): AsyncGenerator<ProjectFile>
{
  const ignored = createIgnoredEntrySet(options.ignoredEntries)
  let yielded = 0

  async function* walk(dir: string): AsyncGenerator<ProjectFile>
  {
    options.signal?.throwIfAborted()
    if (options.maxFiles !== undefined && yielded >= options.maxFiles) return

    let entries
    try
    {
      entries = await readdir(dir, { withFileTypes: true })
      options.signal?.throwIfAborted()
    }
    catch
    {
      options.signal?.throwIfAborted()
      return
    }

    entries.sort((a, b) =>
      compareProjectTreeEntries(
        { name: a.name, isDir: a.isDirectory(), isSymlink: a.isSymbolicLink() },
        { name: b.name, isDir: b.isDirectory(), isSymlink: b.isSymbolicLink() }
      )
    )

    for (const entry of entries)
    {
      options.signal?.throwIfAborted()
      if (options.maxFiles !== undefined && yielded >= options.maxFiles) return
      if (!shouldIncludeProjectTreeEntry(entry.name, ignored)) continue
      // reject symlinks so only real files enter the index
      if (entry.isSymbolicLink()) continue

      const absolutePath = join(dir, entry.name)

      if (entry.isDirectory())
      {
        yield* walk(absolutePath)
        continue
      }

      if (!entry.isFile()) continue

      const path = formatProjectPath(cwd, absolutePath)
      if (options.includePath && !options.includePath(path)) continue

      const file = await statProjectFile(cwd, path, options)
      if (file)
      {
        yield file
        yielded++
      }
    }
  }

  yield* walk(cwd)
}

// lazily yield project files so consumers can stop before walking the whole repo
export async function* iterateProjectFiles(
  cwd: string,
  options: ProjectFileWalkerOptions = {}
): AsyncGenerator<ProjectFile>
{
  options.signal?.throwIfAborted()
  // prefer git's ignore-aware listing and fall back to a manual walk outside a repo
  const gitPaths = await listGitProjectPaths(cwd, options.signal)
  if (gitPaths)
  {
    yield* iterateGitProjectFiles(cwd, gitPaths, options)
    return
  }

  yield* iterateFallbackProjectFiles(cwd, options)
}

export async function collectProjectFiles(
  cwd: string,
  options: ProjectFileWalkerOptions = {}
): Promise<ProjectFile[]>
{
  const files: ProjectFile[] = []
  for await (const file of iterateProjectFiles(cwd, options))
  {
    options.signal?.throwIfAborted()
    files.push(file)
  }
  options.signal?.throwIfAborted()
  return files
}
