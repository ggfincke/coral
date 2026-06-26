// src/retrieval/indexer.ts
// project indexing & semantic search orchestration

import { resolve } from 'node:path'
import { chunkText } from './chunker.js'
import { collectIndexableFiles } from './files.js'
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
  {}

  private refreshKey(): string
  {
    return `${resolve(this.cwd)}\0${this.embedder.model}`
  }

  private async refresh(
    projectId: number,
    options: RefreshOptions = {}
  ): Promise<IndexStats>
  {
    const { force = false, onProgress } = options

    // force ignores cached state so every file re-chunks & re-embeds
    const known = force
      ? new Map<string, IndexedFileStatus>()
      : this.store.listFiles(projectId, this.embedder.model, CHUNKER_VERSION)

    // trusts size+mtime as change signal; sha verified only on stat mismatch
    const { changed, unchangedPaths } = await collectIndexableFiles(
      this.cwd,
      (file) =>
      {
        const row = known.get(file.path)
        return (
          row !== undefined &&
          row.embeddingsCurrent &&
          row.size === file.size &&
          row.mtimeMs === file.mtimeMs
        )
      }
    )

    const currentPaths = new Set(unchangedPaths)
    const total = changed.length
    let processed = 0
    let embeddedFiles = 0
    let chunkCount = 0

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
        this.store.touchFile(
          projectId,
          source.path,
          source.size,
          source.mtimeMs
        )
        report(source.path)
        continue
      }

      const chunks = chunkText(source.content)
      if (chunks.length === 0)
      {
        this.store.deleteFile(projectId, source.path)
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

      const indexedFile: IndexedFile = {
        path: source.path,
        size: source.size,
        mtimeMs: source.mtimeMs,
        sha256: source.sha256,
        chunks: chunks.map((chunk, index) => ({
          ...chunk,
          embedding: embeddings[index],
        })),
      }

      this.store.upsertFile(projectId, indexedFile, this.embedder.model)
      embeddedFiles++
      chunkCount += chunks.length
      report(source.path)
    }

    this.store.deleteMissingFiles(projectId, currentPaths)

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

    // coalesce onto an in-flight refresh for the same project+model; a coalesced
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
  // file; concurrent refreshes for the same project/model share work
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
    return this.store.search(
      projectId,
      this.embedder.model,
      queryVector,
      clampLimit(limit)
    )
  }
}
