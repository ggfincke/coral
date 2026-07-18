// src/retrieval/types.ts
// shared retrieval types and constants

export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text'
export const CHUNKER_VERSION = 1

export interface EmbeddingSpace
{
  id: string
  normalizedHost: string
  artifactDigest: string
  displayModel: string
}

export interface Embedder
{
  space: EmbeddingSpace
  embed(texts: string[]): Promise<number[][]>
}

export interface SourceFile
{
  path: string
  size: number
  mtimeMs: number
  ctimeMs: number
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
  ctimeMs: number
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

// progress reported for each indexed file
export interface IndexProgress
{
  processed: number
  total: number
  path: string
}

// summary returned by an index build
export interface IndexStats
{
  totalFiles: number
  embeddedFiles: number
  chunks: number
}

// cached file state, including whether embeddings match the active chunker
export interface IndexedFileStatus
{
  size: number
  mtimeMs: number
  ctimeMs: number
  sha256: string
  embeddingsCurrent: boolean
}

export interface IndexStore
{
  space: EmbeddingSpace
  ensureProject(cwd: string): number
  listFiles(
    projectId: number,
    chunkerVersion: number
  ): Map<string, IndexedFileStatus>
  touchFile(
    projectId: number,
    path: string,
    size: number,
    mtimeMs: number,
    ctimeMs: number,
    expected: IndexedFileStatus
  ): boolean
  upsertFile(
    projectId: number,
    file: IndexedFile,
    expected: IndexedFileStatus | undefined
  ): boolean
  deleteFile(
    projectId: number,
    path: string,
    expected: IndexedFileStatus | undefined
  ): boolean
  deleteMissingFiles(
    projectId: number,
    currentPaths: Set<string>,
    expectedFiles: Map<string, IndexedFileStatus>
  ): boolean
  search(projectId: number, queryVector: number[], limit: number): SearchHit[]
  close?(): void
}
