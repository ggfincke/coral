// src/retrieval/indexer.ts
// project indexing and semantic search orchestration

import { resolve } from 'node:path'
import { chunkText } from './chunker.js'
import { collectIndexableFiles, revalidateSourceFile } from './files.js'
import type {
  CodeChunk,
  Embedder,
  IndexedFile,
  IndexedFileStatus,
  IndexProgress,
  IndexStats,
  IndexStore,
  SearchHit,
  SourceFile,
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

interface PendingEmbeddingFile
{
  kind: 'embed'
  source: SourceFile
  chunks: CodeChunk[]
  embeddings: number[][]
}

type PendingFileAction =
  | PendingEmbeddingFile
  | { kind: 'touch'; source: SourceFile; expected: IndexedFileStatus }
  | { kind: 'delete'; source: SourceFile }

interface PendingChunk
{
  file: PendingEmbeddingFile
  index: number
}

const inFlightRefreshes = new Map<string, InFlightRefresh>()

function clampLimit(limit: number | undefined): number
{
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return clamp(Math.floor(limit), 1, MAX_LIMIT)
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
    // force bypasses cached state so every file is re-chunked and re-embedded
    const known = force ? new Map<string, IndexedFileStatus>() : snapshot

    // use metadata as the fast path and hash only after a mismatch
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
    const pendingFiles: PendingFileAction[] = []
    const batch: PendingChunk[] = []

    // report progress once per processed file
    const report = (path: string) =>
      onProgress?.({ processed: (processed += 1), total, path })

    // commit complete files in discovery order, including metadata-only work
    const drainReadyFiles = async () =>
    {
      while (pendingFiles.length > 0)
      {
        const action = pendingFiles[0]
        if (
          action.kind === 'embed' &&
          action.embeddings.length !== action.chunks.length
        )
        {
          return
        }
        pendingFiles.shift()

        const { source } = action
        const current = await revalidateSourceFile(this.cwd, source)
        if (!current)
        {
          staleSource = true
          report(source.path)
          continue
        }

        let stored: boolean
        if (action.kind === 'touch')
        {
          stored = this.store.touchFile(
            projectId,
            source.path,
            current.size,
            current.mtimeMs,
            current.ctimeMs,
            action.expected
          )
        }
        else if (action.kind === 'delete')
        {
          stored = this.store.deleteFile(
            projectId,
            source.path,
            snapshot.get(source.path)
          )
        }
        else
        {
          const indexedFile: IndexedFile = {
            path: source.path,
            size: current.size,
            mtimeMs: current.mtimeMs,
            ctimeMs: current.ctimeMs,
            sha256: source.sha256,
            chunks: action.chunks.map((chunk, index) => ({
              ...chunk,
              embedding: action.embeddings[index],
            })),
          }

          stored = this.store.upsertFile(
            projectId,
            indexedFile,
            snapshot.get(source.path)
          )
          embeddedFiles++
          chunkCount += action.chunks.length
        }
        if (!stored) staleSource = true
        report(source.path)
      }
    }

    // batch positions retain their file and chunk ownership until settlement
    const flushBatch = async () =>
    {
      if (batch.length > 0)
      {
        const embeddings = await this.embedder.embed(
          batch.map(({ file, index }) => file.chunks[index].text)
        )
        if (embeddings.length !== batch.length)
        {
          throw new Error(
            `Embedding count mismatch for batch: expected ${batch.length}, got ${embeddings.length}`
          )
        }
        for (const [index, chunk] of batch.entries())
        {
          chunk.file.embeddings[chunk.index] = embeddings[index]
        }
        batch.length = 0
      }
      await drainReadyFiles()
    }

    for (const source of changed)
    {
      currentPaths.add(source.path)
      // bound metadata-only actions waiting behind an unfinished batch
      if (pendingFiles.length >= EMBED_BATCH_SIZE) await flushBatch()

      const row = known.get(source.path)
      if (row?.embeddingsCurrent && row.sha256 === source.sha256)
      {
        pendingFiles.push({ kind: 'touch', source, expected: row })
        await drainReadyFiles()
        continue
      }

      const chunks = chunkText(source.content)
      if (chunks.length === 0)
      {
        pendingFiles.push({ kind: 'delete', source })
        await drainReadyFiles()
        continue
      }

      const file: PendingEmbeddingFile = {
        kind: 'embed',
        source,
        chunks,
        embeddings: [],
      }
      pendingFiles.push(file)
      for (const index of chunks.keys())
      {
        batch.push({ file, index })
        if (batch.length === EMBED_BATCH_SIZE) await flushBatch()
      }
    }
    await flushBatch()

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

    // share an in-flight refresh for the same project and embedding space
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

  // build or refresh the index, sharing concurrent work for the same project
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
