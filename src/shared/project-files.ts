// src/shared/project-files.ts
// neutral project file discovery w/ git-aware ignore handling

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

export interface ProjectFile
{
  path: string
  absolutePath: string
  size: number
  mtimeMs: number
}

export interface ProjectFileWalkerOptions
{
  maxFiles?: number
  maxFileBytes?: number
  ignoredEntries?: Iterable<string>
  includePath?: (path: string) => boolean
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
  const absolutePath = join(cwd, path)

  let info
  try
  {
    // skip symlinks — only real files are indexable
    info = await lstat(absolutePath)
    if (info.isSymbolicLink()) return null
  }
  catch
  {
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
  }
}

// git's ignore-aware path list in deterministic order, or null outside a repo
async function listGitProjectPaths(cwd: string): Promise<string[] | null>
{
  const result = await runGitCommand(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    cwd,
    { maxBuffer: GIT_FILE_LIST_MAX_BUFFER }
  )

  if (result.error) return null

  // deterministic code-unit order; localeCompare varies w/ the host locale
  return result.output
    .split('\0')
    .filter(Boolean)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

async function* iterateGitProjectFiles(
  cwd: string,
  paths: string[],
  options: ProjectFileWalkerOptions
): AsyncGenerator<ProjectFile>
{
  const ignored = createIgnoredEntrySet(options.ignoredEntries)
  let yielded = 0

  for (const path of paths)
  {
    if (options.maxFiles !== undefined && yielded >= options.maxFiles) return
    if (hasIgnoredPathSegment(path, ignored)) continue
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
    if (options.maxFiles !== undefined && yielded >= options.maxFiles) return

    let entries
    try
    {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch
    {
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
      if (options.maxFiles !== undefined && yielded >= options.maxFiles) return
      if (!shouldIncludeProjectTreeEntry(entry.name, ignored)) continue
      // skip symlinks — only real files are indexable
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

// lazily yield project files so a consumer can stop early (e.g. after N
// accepted files) without stat-ing or walking the rest of a huge repo
export async function* iterateProjectFiles(
  cwd: string,
  options: ProjectFileWalkerOptions = {}
): AsyncGenerator<ProjectFile>
{
  // prefer git's ignore-aware listing; fall back to a manual walk outside a repo
  const gitPaths = await listGitProjectPaths(cwd)
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
    files.push(file)
  }
  return files
}
