// src/retrieval/files.ts
// project file discovery for semantic indexing

import { createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  iterateProjectFiles,
  type ProjectFile,
} from '../shared/project-files.js'
import { isLikelyTextPath } from '../shared/text-paths.js'
import type { SourceFile } from './types.js'

const MAX_INDEXABLE_FILE_BYTES = 512 * 1024
const MAX_PROJECT_FILES = 2_000
const TEXT_SAMPLE_BYTES = 4_096
const RETRIEVAL_IGNORED_ENTRIES = ['.coral', '.coral-retrieval']

export type ProjectFileStat = Pick<
  ProjectFile,
  'path' | 'size' | 'mtimeMs' | 'ctimeMs'
>

export interface CollectedFiles
{
  changed: SourceFile[]
  unchangedPaths: string[]
  // files that listed but could not be read, such as EACCES; deletes are omitted
  unreadablePaths: string[]
}

export interface RevalidatedSourceStat
{
  size: number
  mtimeMs: number
  ctimeMs: number
}

function isMissingFile(error: unknown): boolean
{
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
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
  fileStat: ProjectFile
): Promise<SourceFile | null>
{
  const buffer = await readFile(fileStat.absolutePath)
  if (!isProbablyText(buffer)) return null

  return {
    path: fileStat.path,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    content: buffer.toString('utf8'),
  }
}

// use metadata first so current files are not read or hashed
export async function collectIndexableFiles(
  cwd: string,
  isCurrent: (file: ProjectFileStat) => boolean
): Promise<CollectedFiles>
{
  const changed: SourceFile[] = []
  const unchangedPaths: string[] = []
  const unreadablePaths: string[] = []

  // stop after the project-file limit; binary content does not consume a slot
  for await (const file of iterateProjectFiles(cwd, {
    maxFileBytes: MAX_INDEXABLE_FILE_BYTES,
    ignoredEntries: RETRIEVAL_IGNORED_ENTRIES,
    includePath: isLikelyTextPath,
  }))
  {
    if (changed.length + unchangedPaths.length >= MAX_PROJECT_FILES) break

    if (isCurrent(file))
    {
      unchangedPaths.push(file.path)
      continue
    }

    // one unreadable file drops out of the index instead of failing the refresh
    let source: SourceFile | null
    try
    {
      source = await readSourceFile(file)
    }
    catch (error)
    {
      // a file deleted since listing just drops out with no report
      if (!isMissingFile(error)) unreadablePaths.push(file.path)
      continue
    }
    if (source) changed.push(source)
  }

  return { changed, unchangedPaths, unreadablePaths }
}

// revalidate bytes through one descriptor immediately before persistence;
// 'missing' means the file is gone, 'changed' covers every other mismatch
export async function revalidateSourceFile(
  cwd: string,
  source: SourceFile
): Promise<RevalidatedSourceStat | 'changed' | 'missing'>
{
  let handle
  try
  {
    handle = await open(resolve(cwd, source.path), 'r')
    const before = await handle.stat()
    if (!before.isFile()) return 'changed'

    const buffer = await handle.readFile()
    const after = await handle.stat()
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      buffer.length !== after.size
    )
    {
      return 'changed'
    }

    const digest = createHash('sha256').update(buffer).digest('hex')
    if (digest !== source.sha256) return 'changed'
    return {
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    }
  }
  catch (error)
  {
    return isMissingFile(error) ? 'missing' : 'changed'
  }
  finally
  {
    await handle?.close()
  }
}
