// src/tools/list-files.ts
// list directory contents as an indented tree

import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolExecutionContext, ToolResult } from './tool.js'
import { getCwd } from '../cwd.js'
import { checkWorkspacePath } from './path-policy.js'
import { clamp } from '../utils/clamp.js'
import { createIgnoredEntrySet } from '../shared/ignored-entries.js'
import {
  formatProjectDirectoryPath,
  formatProjectTreeEntryName,
  shouldIncludeProjectTreeEntry,
} from '../shared/project-tree.js'

const MAX_ENTRIES = 200
const DEFAULT_DEPTH = 2
const MAX_DEPTH = 5
const INDENT = '  '

// directories to always skip
const IGNORED = createIgnoredEntrySet()

// entry collected during traversal
interface Entry
{
  name: string
  depth: number
  isDir: boolean
  isSymlink: boolean
}

// traverse the tree depth-first so children stay attached to their parent
async function collectEntries(
  root: string,
  maxDepth: number
): Promise<{ entries: Entry[]; truncated: boolean }>
{
  const entries: Entry[] = []
  let truncated = false

  async function walk(dir: string, depth: number): Promise<void>
  {
    let dirents: Dirent[]
    try
    {
      dirents = await readdir(dir, { withFileTypes: true })
    }
    catch
    {
      return
    }

    const filtered = dirents
      .filter((d) => shouldIncludeProjectTreeEntry(d.name, IGNORED))
      .sort((a, b) => a.name.localeCompare(b.name))

    for (const dirent of filtered)
    {
      const isSymlink = dirent.isSymbolicLink()
      let isDir = dirent.isDirectory()

      if (isSymlink)
      {
        try
        {
          const stats = await stat(join(dir, dirent.name))
          isDir = stats.isDirectory()
        }
        catch
        {
          continue
        }
      }

      entries.push({ name: dirent.name, depth, isDir, isSymlink })

      if (entries.length >= MAX_ENTRIES)
      {
        truncated = true
        return
      }

      if (isDir && !isSymlink && depth + 1 < maxDepth)
      {
        await walk(join(dir, dirent.name), depth + 1)

        if (truncated)
        {
          return
        }
      }
    }
  }

  await walk(root, 0)
  return { entries, truncated }
}

// format entries into an indented tree string
function formatTree(
  cwd: string,
  root: string,
  entries: Entry[],
  truncated: boolean
): string
{
  const lines: string[] = [formatProjectDirectoryPath(cwd, root)]

  for (const entry of entries)
  {
    const indent = INDENT.repeat(entry.depth + 1)
    lines.push(`${indent}${formatProjectTreeEntryName(entry)}`)
  }

  if (truncated)
  {
    lines.push(
      `(Showing first ${MAX_ENTRIES} entries — use a smaller depth or more specific path)`
    )
  }

  return lines.join('\n')
}

export const listFilesTool: Tool = {
  name: 'list_files',
  description:
    "List directory contents as an indented tree. Directories are marked w/ trailing '/'. Skips .git, node_modules, & other common noise directories.",
  subagentSafe: true,
  parallelSafe: true,
  display: { label: 'List', summarize: (args) => String(args.path ?? '.') },
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to list (default: working directory)',
      },
      depth: {
        type: 'number',
        description: `Max recursion depth (default: ${DEFAULT_DEPTH}, max: ${MAX_DEPTH})`,
      },
    },
    required: [],
  },
  async execute(args, context?: ToolExecutionContext): Promise<ToolResult>
  {
    const cwd = context?.cwd ?? getCwd()
    const allowed = await checkWorkspacePath(
      cwd,
      args.path as string | undefined,
      context?.allowOutsideWorkspace === true
    )
    if (!allowed.ok) return { output: '', error: allowed.error }

    const path = allowed.path
    const rawDepth = (args.depth as number) ?? DEFAULT_DEPTH
    const depth = clamp(Math.floor(rawDepth), 1, MAX_DEPTH)

    // verify the path is a directory
    try
    {
      const stats = await stat(path)
      if (!stats.isDirectory())
      {
        return { output: '', error: `${path} is not a directory` }
      }
    }
    catch
    {
      return { output: '', error: `Cannot access ${path}: no such directory` }
    }

    const { entries, truncated } = await collectEntries(path, depth)

    if (entries.length === 0)
    {
      return { output: `${formatProjectDirectoryPath(cwd, path)} (empty)` }
    }

    return { output: formatTree(cwd, path, entries, truncated) }
  },
}
