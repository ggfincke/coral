// src/shared/project-tree.ts
// project tree filtering, sorting, & entry formatting

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
