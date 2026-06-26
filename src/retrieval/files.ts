// src/retrieval/files.ts
// project file discovery for semantic indexing

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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

export type ProjectFileStat = Pick<ProjectFile, 'path' | 'size' | 'mtimeMs'>

export interface CollectedFiles
{
  changed: SourceFile[]
  unchangedPaths: string[]
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

  // lazy walk: stop once MAX_PROJECT_FILES are accepted (a binary file w/ a
  // text extension is dropped by readSourceFile & must not consume a slot)
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

    const source = await readSourceFile(file)
    if (source) changed.push(source)
  }

  return { changed, unchangedPaths }
}
