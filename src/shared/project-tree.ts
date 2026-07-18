// src/shared/project-tree.ts
// project tree filtering, sorting, and entry formatting

import { isAbsolute, relative, sep } from 'node:path'

export interface ProjectTreeEntry
{
  name: string
  isDir: boolean
  isSymlink?: boolean
}

interface FilterOptions
{
  includeHidden?: boolean
}

interface SortOptions
{
  directoriesFirst?: boolean
}

export function shouldIncludeProjectTreeEntry(
  name: string,
  ignored: Set<string>,
  options: FilterOptions = {}
): boolean
{
  if (ignored.has(name)) return false
  if (options.includeHidden === false && name.startsWith('.')) return false
  return true
}

export function compareProjectTreeEntries(
  left: ProjectTreeEntry,
  right: ProjectTreeEntry,
  options: SortOptions = {}
): number
{
  if (options.directoriesFirst && left.isDir !== right.isDir)
  {
    return left.isDir ? -1 : 1
  }

  return left.name.localeCompare(right.name)
}

export function formatProjectTreeEntryName(entry: ProjectTreeEntry): string
{
  let suffix = ''
  if (entry.isDir) suffix += '/'
  if (entry.isSymlink) suffix += '@'
  return `${entry.name}${suffix}`
}

export function isPathInsideProject(
  cwd: string,
  absolutePath: string
): boolean
{
  const projectPath = relative(cwd, absolutePath)
  return (
    projectPath === '' ||
    (!isAbsolute(projectPath) &&
      projectPath !== '..' &&
      !projectPath.startsWith(`..${sep}`))
  )
}

export function formatProjectPath(cwd: string, absolutePath: string): string
{
  const projectPath = relative(cwd, absolutePath)
  if (projectPath === '') return '.'

  if (isPathInsideProject(cwd, absolutePath))
  {
    return projectPath.split(sep).join('/')
  }

  return absolutePath.split(sep).join('/')
}

export function formatProjectDirectoryPath(
  cwd: string,
  absolutePath: string
): string
{
  const displayPath = formatProjectPath(cwd, absolutePath)
  return displayPath.endsWith('/') ? displayPath : `${displayPath}/`
}
