// src/retrieval/indexer.ts
// project indexing & semantic search orchestration

import { resolve } from 'node:path'
import { chunkText } from './chunker.js'
import { collectIndexableFiles, revalidateSourceFile } from './files.js'
import type {
  Embedder,
  IndexedFile,
  IndexedFileStatus,
  IndexProgress,
  IndexStats,
  IndexStore,
  SearchHit,
} from './types.js'
import { CHUNKER_VERSION } from './types.js'
import { clamp } from '../utils/clamp.js'

export const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const EMBED_BATCH_SIZE = 16
const MAX_STALE_SOURCE_RETRIES = 2

interface RefreshOptions
{
  force?: boolean
  onProgress?: (progress: IndexProgress) => void
}

interface InFlightRefresh
{
  force: boolean
  promise: Promise<IndexStats>
}

const inFlightRefreshes = new Map<string, InFlightRefresh>()

function clampLimit(limit: number | undefined): number
{
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return clamp(Math.floor(limit), 1, MAX_LIMIT)
}

async function embedInBatches(
  embedder: Embedder,
  texts: string[]
): Promise<number[][]>
{
  const vectors: number[][] = []

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE)
  {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE)
    vectors.push(...(await embedder.embed(batch)))
  }

  return vectors
}

export class ProjectIndexer
{
  constructor(
    private cwd: string,
    private embedder: Embedder,
    private store: IndexStore
  )
  {
    if (embedder.space.id !== store.space.id)
    {
      throw new Error('Retrieval embedder and index store use different spaces')
    }
  }

  private refreshKey(): string
  {
    return `${resolve(this.cwd)}\0${this.embedder.space.id}`
  }

  private async refresh(
    projectId: number,
    options: RefreshOptions = {},
    staleRetry = 0
  ): Promise<IndexStats>
  {
    const { force = false, onProgress } = options

    const snapshot = this.store.listFiles(projectId, CHUNKER_VERSION)
    // force ignores cached state so every file re-chunks & re-embeds
    const known = force ? new Map<string, IndexedFileStatus>() : snapshot

    // trust size+mtime+ctime as the fast-path token; hash on stat mismatch
    const { changed, unchangedPaths } = await collectIndexableFiles(
      this.cwd,
      (file) =>
      {
        const row = known.get(file.path)
        return (
          row !== undefined &&
          row.embeddingsCurrent &&
          row.size === file.size &&
          row.mtimeMs === file.mtimeMs &&
          row.ctimeMs === file.ctimeMs
        )
      }
    )

    const currentPaths = new Set(unchangedPaths)
    const total = changed.length
    let processed = 0
    let embeddedFiles = 0
    let chunkCount = 0
    let staleSource = false

    // fire progress once per processed file; ++ only when a listener is attached
    const report = (path: string) =>
      onProgress?.({ processed: (processed += 1), total, path })

    for (const source of changed)
    {
      currentPaths.add(source.path)

      // mtime churn w/ identical content -> refresh metadata, keep embeddings
      const row = known.get(source.path)
      if (row?.embeddingsCurrent && row.sha256 === source.sha256)
      {
        const current = await revalidateSourceFile(this.cwd, source)
        if (!current)
        {
          staleSource = true
          report(source.path)
          continue
        }

        const touched = this.store.touchFile(
          projectId,
          source.path,
          current.size,
          current.mtimeMs,
          current.ctimeMs,
          row
        )
        if (!touched) staleSource = true
        report(source.path)
        continue
      }

      const chunks = chunkText(source.content)
      if (chunks.length === 0)
      {
        const current = await revalidateSourceFile(this.cwd, source)
        if (!current)
        {
          staleSource = true
          report(source.path)
          continue
        }

        const deleted = this.store.deleteFile(
          projectId,
          source.path,
          snapshot.get(source.path)
        )
        if (!deleted) staleSource = true
        report(source.path)
        continue
      }

      const embeddings = await embedInBatches(
        this.embedder,
        chunks.map((chunk) => chunk.text)
      )

      if (embeddings.length !== chunks.length)
      {
        throw new Error(
          `Embedding count mismatch for ${source.path}: expected ${chunks.length}, got ${embeddings.length}`
        )
      }

      const current = await revalidateSourceFile(this.cwd, source)
      if (!current)
      {
        staleSource = true
        report(source.path)
        continue
      }

      const indexedFile: IndexedFile = {
        path: source.path,
        size: current.size,
        mtimeMs: current.mtimeMs,
        ctimeMs: current.ctimeMs,
        sha256: source.sha256,
        chunks: chunks.map((chunk, index) => ({
          ...chunk,
          embedding: embeddings[index],
        })),
      }

      const stored = this.store.upsertFile(
        projectId,
        indexedFile,
        snapshot.get(source.path)
      )
      if (!stored) staleSource = true
      embeddedFiles++
      chunkCount += chunks.length
      report(source.path)
    }

    if (staleSource)
    {
      if (staleRetry >= MAX_STALE_SOURCE_RETRIES)
      {
        throw new Error(
          'Project files kept changing while Coral embedded them; retry indexing after the edits settle'
        )
      }
      return this.refresh(projectId, options, staleRetry + 1)
    }

    const deletedMissing = this.store.deleteMissingFiles(
      projectId,
      currentPaths,
      snapshot
    )
    if (!deletedMissing)
    {
      if (staleRetry >= MAX_STALE_SOURCE_RETRIES)
      {
        throw new Error(
          'Project index changed concurrently during cleanup; retry after the active indexers settle'
        )
      }
      return this.refresh(projectId, options, staleRetry + 1)
    }

    return {
      totalFiles: changed.length + unchangedPaths.length,
      embeddedFiles,
      chunks: chunkCount,
    }
  }

  private async refreshDeduped(
    options: RefreshOptions = {}
  ): Promise<IndexStats>
  {
    const force = options.force ?? false
    const key = this.refreshKey()

    // coalesce onto an in-flight refresh for the same project+space; a coalesced
    // caller shares the original's progress/store/embedder & gets its stats
    while (true)
    {
      const existing = inFlightRefreshes.get(key)
      if (!existing) break

      const stats = await existing.promise
      if (!force || existing.force) return stats
    }

    const promise = (async () =>
    {
      const projectId = this.store.ensureProject(this.cwd)
      return this.refresh(projectId, options)
    })()

    inFlightRefreshes.set(key, { force, promise })

    try
    {
      return await promise
    }
    finally
    {
      if (inFlightRefreshes.get(key)?.promise === promise)
      {
        inFlightRefreshes.delete(key)
      }
    }
  }

  // build or refresh the index, returning a summary. force re-embeds every
  // file; concurrent refreshes for the same project/space share work
  async ensureIndexed(options?: RefreshOptions): Promise<IndexStats>
  {
    return this.refreshDeduped(options)
  }

  async search(query: string, limit?: number): Promise<SearchHit[]>
  {
    const trimmed = query.trim()
    if (!trimmed) return []

    await this.refreshDeduped()

    const [queryVector] = await this.embedder.embed([trimmed])
    if (!queryVector) return []

    const projectId = this.store.ensureProject(this.cwd)
    return this.store.search(projectId, queryVector, clampLimit(limit))
  }
}
