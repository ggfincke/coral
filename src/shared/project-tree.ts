// src/shared/project-tree.ts
// project tree filtering, sorting, and entry formatting

import { relative, sep } from 'node:path'
import { isPathInsideProject } from '../utils/path-containment.js'

export interface ProjectTreeEntry
{
  name: string
  isDir: boolean
  isSymlink?: boolean
}

export function shouldIncludeProjectTreeEntry(
  name: string,
  ignored: Set<string>
): boolean
{
  return !ignored.has(name)
}

export function compareProjectTreeEntries(
  left: ProjectTreeEntry,
  right: ProjectTreeEntry
): number
{
  return left.name.localeCompare(right.name)
}

export function formatProjectTreeEntryName(entry: ProjectTreeEntry): string
{
  let suffix = ''
  if (entry.isDir) suffix += '/'
  if (entry.isSymlink) suffix += '@'
  return `${entry.name}${suffix}`
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
