// src/retrieval/types.ts
// shared retrieval types & constants

export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text'
export const CHUNKER_VERSION = 1

export interface Embedder
{
  model: string
  embed(texts: string[]): Promise<number[][]>
}

export interface SourceFile
{
  path: string
  size: number
  mtimeMs: number
  sha256: string
  content: string
}

export interface CodeChunk
{
  chunkIndex: number
  startLine: number
  endLine: number
  text: string
  chunkerVersion: number
}

export interface EmbeddedChunk extends CodeChunk
{
  embedding: number[]
}

export interface IndexedFile
{
  path: string
  size: number
  mtimeMs: number
  sha256: string
  chunks: EmbeddedChunk[]
}

export interface SearchHit
{
  path: string
  startLine: number
  endLine: number
  score: number
  text: string
}

// indexed state per file; embeddingsCurrent = chunks complete for model + chunker version
export interface IndexedFileStatus
{
  size: number
  mtimeMs: number
  sha256: string
  embeddingsCurrent: boolean
}

export interface IndexStore
{
  ensureProject(cwd: string): number
  listFiles(
    projectId: number,
    model: string,
    chunkerVersion: number
  ): Map<string, IndexedFileStatus>
  touchFile(
    projectId: number,
    path: string,
    size: number,
    mtimeMs: number
  ): void
  upsertFile(projectId: number, file: IndexedFile, model: string): void
  deleteFile(projectId: number, path: string): void
  deleteMissingFiles(projectId: number, currentPaths: Set<string>): void
  search(
    projectId: number,
    model: string,
    queryVector: number[],
    limit: number
  ): SearchHit[]
  close?(): void
}
