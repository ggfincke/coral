// src/retrieval/files.ts
// project file discovery for semantic indexing

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { createIgnoredEntrySet } from '../shared/ignored-entries.js'
import type { SourceFile } from './types.js'

const MAX_FILE_BYTES = 512 * 1024
const MAX_PROJECT_FILES = 2_000
const TEXT_SAMPLE_BYTES = 4_096
const IGNORED_ENTRIES = createIgnoredEntrySet(['.coral', '.coral-retrieval'])

export interface ProjectFileStat
{
  path: string
  size: number
  mtimeMs: number
}

export interface CollectedFiles
{
  changed: SourceFile[]
  unchangedPaths: string[]
}

function toProjectPath(cwd: string, absolutePath: string): string
{
  return relative(cwd, absolutePath).split(sep).join('/')
}

function isProbablyText(buffer: Buffer): boolean
{
  if (buffer.length === 0) return false
  if (buffer.includes(0)) return false

  const sample = buffer.subarray(0, TEXT_SAMPLE_BYTES).toString('utf8')
  const replacements = sample.match(/\uFFFD/g)?.length ?? 0
  return replacements < Math.max(sample.length * 0.05, 1)
}

async function readSourceFile(
  fileStat: ProjectFileStat,
  absolutePath: string
): Promise<SourceFile | null>
{
  const buffer = await readFile(absolutePath)
  if (!isProbablyText(buffer)) return null

  return {
    path: fileStat.path,
    absolutePath,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    content: buffer.toString('utf8'),
  }
}

// stat-first walk: files passing isCurrent are never read or hashed
export async function collectIndexableFiles(
  cwd: string,
  isCurrent: (file: ProjectFileStat) => boolean
): Promise<CollectedFiles>
{
  const changed: SourceFile[] = []
  const unchangedPaths: string[] = []
  let fileCount = 0

  async function walk(dir: string): Promise<void>
  {
    if (fileCount >= MAX_PROJECT_FILES) return

    let entries
    try
    {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch
    {
      return
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries)
    {
      if (fileCount >= MAX_PROJECT_FILES) return
      if (IGNORED_ENTRIES.has(entry.name)) continue
      if (entry.isSymbolicLink()) continue

      const path = join(dir, entry.name)

      if (entry.isDirectory())
      {
        await walk(path)
        continue
      }

      if (!entry.isFile()) continue

      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue

      const fileStat: ProjectFileStat = {
        path: toProjectPath(cwd, path),
        size: info.size,
        mtimeMs: info.mtimeMs,
      }

      if (isCurrent(fileStat))
      {
        unchangedPaths.push(fileStat.path)
        fileCount++
        continue
      }

      const source = await readSourceFile(fileStat, path)
      if (source)
      {
        changed.push(source)
        fileCount++
      }
    }
  }

  await walk(cwd)
  return { changed, unchangedPaths }
}
