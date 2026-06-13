// src/retrieval/indexer.ts
// project indexing & semantic search orchestration

import { chunkText } from './chunker.js'
import { collectIndexableFiles } from './files.js'
import type { Embedder, IndexedFile, IndexStore, SearchHit } from './types.js'
import { CHUNKER_VERSION } from './types.js'
import { clamp } from '../utils/clamp.js'

export const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const EMBED_BATCH_SIZE = 16

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

  private async refresh(projectId: number): Promise<void>
  {
    const known = this.store.listFiles(
      projectId,
      this.embedder.model,
      CHUNKER_VERSION
    )

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
        continue
      }

      const chunks = chunkText(source.content)
      if (chunks.length === 0)
      {
        this.store.deleteFile(projectId, source.path)
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
    }

    this.store.deleteMissingFiles(projectId, currentPaths)
  }

  async search(query: string, limit?: number): Promise<SearchHit[]>
  {
    const trimmed = query.trim()
    if (!trimmed) return []

    const projectId = this.store.ensureProject(this.cwd)
    await this.refresh(projectId)

    const [queryVector] = await this.embedder.embed([trimmed])
    if (!queryVector) return []

    return this.store.search(
      projectId,
      this.embedder.model,
      queryVector,
      clampLimit(limit)
    )
  }
}
