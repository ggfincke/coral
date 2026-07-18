// src/retrieval/sqlite-store.ts
// versioned SQLite semantic index per embedding space

import Database from 'better-sqlite3'
import { chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { coralHomePath } from '../utils/coral-home.js'
import { ensureParentDir } from '../utils/fs.js'
import { assertEmbeddingSpace } from './embedding-space.js'
import { blobToVector, cosineSimilarity, vectorToBlob } from './vector.js'
import type {
  EmbeddingSpace,
  IndexedFile,
  IndexedFileStatus,
  IndexStore,
  SearchHit,
} from './types.js'

export const RETRIEVAL_SCHEMA_VERSION = 2
export const RETRIEVAL_APPLICATION_ID = 0x43524c32
export const RETRIEVAL_BUSY_TIMEOUT_MS = 5_000
const MAX_BUSY_RETRY_DELAY_MS = 100
const BUSY_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(4))

interface IdRow
{
  id: number
}

interface CountRow
{
  count: number
}

interface SpaceMetadataRow
{
  space_id: string
  normalized_host: string
  artifact_digest: string
  display_model: string
  embedding_dimensions: number | null
}

interface FileStatusRow
{
  path: string
  size: number
  mtime_ms: number
  ctime_ms: number
  sha256: string
  chunks: number
  embeddings: number
}

interface CurrentFileRow
{
  sha256: string
  chunks: number
  embeddings: number
}

interface SearchRow
{
  path: string
  start_line: number
  end_line: number
  text: string
  dims: number
  vector: Buffer
}

interface SqliteStoreOptions
{
  busyTimeoutMs?: number
}

export function embeddingSpaceDbPath(space: EmbeddingSpace): string
{
  assertEmbeddingSpace(space)
  return coralHomePath('retrieval', 'v2', 'spaces', `${space.id}.sqlite`)
}

function errorCode(err: unknown): string | undefined
{
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined
  return typeof err.code === 'string' ? err.code : undefined
}

function isContentionError(err: unknown): boolean
{
  const code = errorCode(err)
  return (
    code?.startsWith('SQLITE_BUSY') === true ||
    code?.startsWith('SQLITE_LOCKED') === true
  )
}

function waitForBusyRetry(delayMs: number): void
{
  Atomics.wait(BUSY_RETRY_SIGNAL, 0, 0, delayMs)
}

function pragmaNumber(value: unknown, name: string): number
{
  if (typeof value !== 'number')
  {
    throw new Error(`SQLite did not return numeric PRAGMA ${name}`)
  }
  return value
}

export class SqliteIndexStore implements IndexStore
{
  private db: Database.Database
  private busyTimeoutMs: number

  constructor(
    public readonly space: EmbeddingSpace,
    path = embeddingSpaceDbPath(space),
    options: SqliteStoreOptions = {}
  )
  {
    assertEmbeddingSpace(space)
    this.busyTimeoutMs = options.busyTimeoutMs ?? RETRIEVAL_BUSY_TIMEOUT_MS
    if (!Number.isInteger(this.busyTimeoutMs) || this.busyTimeoutMs < 0)
    {
      throw new Error(
        'Retrieval SQLite busy timeout must be a non-negative integer'
      )
    }

    ensureParentDir(path)
    this.db = new Database(path, { timeout: this.busyTimeoutMs })

    try
    {
      if (process.platform !== 'win32') chmodSync(path, 0o600)
      this.configure()
      this.migrate()
      this.validateMetadata()
    }
    catch (err)
    {
      this.db.close()
      throw err
    }
  }

  private withBusyContext<T>(operation: string, fn: () => T): T
  {
    const deadline = performance.now() + this.busyTimeoutMs
    let retryDelayMs = 10

    while (true)
    {
      try
      {
        return fn()
      }
      catch (err)
      {
        if (!isContentionError(err)) throw err

        const remainingMs = deadline - performance.now()
        if (remainingMs <= 0)
        {
          throw new Error(
            `Retrieval cache stayed busy or locked for ${this.busyTimeoutMs}ms while ${operation}; another Coral process may be updating this embedding space, so retry the search or index command`,
            { cause: err }
          )
        }

        const delayMs = Math.min(retryDelayMs, remainingMs)
        waitForBusyRetry(delayMs)
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_BUSY_RETRY_DELAY_MS)
      }
    }
  }

  private configure(): void
  {
    this.withBusyContext('opening the database', () =>
    {
      this.db.pragma(`busy_timeout = ${this.busyTimeoutMs}`)
      this.db.pragma('foreign_keys = ON')
      const journalMode = this.db.pragma('journal_mode = WAL', {
        simple: true,
      })
      if (journalMode !== 'wal')
      {
        throw new Error(
          `Retrieval cache requires SQLite WAL mode; database reported ${String(journalMode)}`
        )
      }

      this.db.pragma('synchronous = NORMAL')
      this.db.pragma('trusted_schema = OFF')

      if (
        pragmaNumber(
          this.db.pragma('busy_timeout', { simple: true }),
          'busy_timeout'
        ) !== this.busyTimeoutMs
      )
      {
        throw new Error('Retrieval cache could not set the SQLite busy timeout')
      }
      if (
        pragmaNumber(
          this.db.pragma('foreign_keys', { simple: true }),
          'foreign_keys'
        ) !== 1
      )
      {
        throw new Error('Retrieval cache could not enable SQLite foreign keys')
      }
      if (
        pragmaNumber(
          this.db.pragma('synchronous', { simple: true }),
          'synchronous'
        ) !== 1
      )
      {
        throw new Error('Retrieval cache could not enable SQLite NORMAL sync')
      }
      if (
        pragmaNumber(
          this.db.pragma('trusted_schema', { simple: true }),
          'trusted_schema'
        ) !== 0
      )
      {
        throw new Error(
          'Retrieval cache could not disable trusted SQLite schemas'
        )
      }
    })
  }

  private migrate(): void
  {
    const migrate = this.db.transaction(() =>
    {
      const applicationId = pragmaNumber(
        this.db.pragma('application_id', { simple: true }),
        'application_id'
      )
      const version = pragmaNumber(
        this.db.pragma('user_version', { simple: true }),
        'user_version'
      )
      if (version === RETRIEVAL_SCHEMA_VERSION)
      {
        if (applicationId !== RETRIEVAL_APPLICATION_ID)
        {
          throw new Error(
            `Retrieval cache application ID mismatch: expected ${RETRIEVAL_APPLICATION_ID}, got ${applicationId}`
          )
        }
        return
      }
      if (version !== 0)
      {
        throw new Error(
          `Unsupported retrieval cache schema version ${version}; expected ${RETRIEVAL_SCHEMA_VERSION}`
        )
      }
      if (applicationId !== 0)
      {
        throw new Error(
          `Refusing to initialize a retrieval cache carrying application ID ${applicationId}`
        )
      }

      const existing = this.db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        `
        )
        .get() as CountRow
      if (existing.count !== 0)
      {
        throw new Error(
          'Refusing to reinterpret unversioned data in the v2 retrieval cache namespace'
        )
      }

      this.db.exec(`
        CREATE TABLE cache_metadata (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          space_id TEXT NOT NULL,
          normalized_host TEXT NOT NULL,
          artifact_digest TEXT NOT NULL,
          display_model TEXT NOT NULL,
          embedding_dimensions INTEGER
            CHECK(embedding_dimensions IS NULL OR embedding_dimensions > 0),
          created_at TEXT NOT NULL
        );

        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          cwd TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE files (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          ctime_ms REAL NOT NULL,
          sha256 TEXT NOT NULL,
          indexed_at TEXT NOT NULL,
          UNIQUE(project_id, path)
        );

        CREATE TABLE chunks (
          id INTEGER PRIMARY KEY,
          file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          text TEXT NOT NULL,
          chunker_version INTEGER NOT NULL,
          UNIQUE(file_id, chunk_index)
        );

        CREATE TABLE embeddings (
          chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
          dims INTEGER NOT NULL CHECK(dims > 0),
          vector BLOB NOT NULL
        );

        CREATE INDEX idx_files_project ON files(project_id);
      `)

      this.db
        .prepare(
          `
          INSERT INTO cache_metadata (
            singleton,
            space_id,
            normalized_host,
            artifact_digest,
            display_model,
            embedding_dimensions,
            created_at
          )
          VALUES (1, ?, ?, ?, ?, NULL, ?)
        `
        )
        .run(
          this.space.id,
          this.space.normalizedHost,
          this.space.artifactDigest,
          this.space.displayModel,
          this.now()
        )

      this.db.pragma(`application_id = ${RETRIEVAL_APPLICATION_ID}`)
      this.db.pragma(`user_version = ${RETRIEVAL_SCHEMA_VERSION}`)
    })

    this.withBusyContext('initializing the database schema', () =>
      migrate.immediate()
    )

    this.withBusyContext('validating the database schema', () =>
    {
      const applicationId = pragmaNumber(
        this.db.pragma('application_id', { simple: true }),
        'application_id'
      )
      const version = pragmaNumber(
        this.db.pragma('user_version', { simple: true }),
        'user_version'
      )
      if (applicationId !== RETRIEVAL_APPLICATION_ID)
      {
        throw new Error(
          `Retrieval cache application ID mismatch: expected ${RETRIEVAL_APPLICATION_ID}, got ${applicationId}`
        )
      }
      if (version !== RETRIEVAL_SCHEMA_VERSION)
      {
        throw new Error(
          `Retrieval cache schema version mismatch: expected ${RETRIEVAL_SCHEMA_VERSION}, got ${version}`
        )
      }
    })
  }

  private metadata(): SpaceMetadataRow
  {
    const row = this.db
      .prepare(
        `
        SELECT
          space_id,
          normalized_host,
          artifact_digest,
          display_model,
          embedding_dimensions
        FROM cache_metadata
        WHERE singleton = 1
      `
      )
      .get() as SpaceMetadataRow | undefined

    if (!row)
      throw new Error('Retrieval cache is missing embedding-space metadata')
    return row
  }

  private validateMetadata(): void
  {
    this.withBusyContext('validating embedding-space metadata', () =>
    {
      const row = this.metadata()
      if (
        row.space_id !== this.space.id ||
        row.normalized_host !== this.space.normalizedHost ||
        row.artifact_digest !== this.space.artifactDigest
      )
      {
        throw new Error(
          'Retrieval cache embedding-space metadata does not match its requested identity'
        )
      }
    })
  }

  private dimensionsFor(file: IndexedFile): number
  {
    const dimensions = file.chunks[0]?.embedding.length ?? 0
    if (dimensions <= 0)
    {
      throw new Error(`Cannot upsert ${file.path} without embedding dimensions`)
    }

    for (const chunk of file.chunks)
    {
      if (
        chunk.embedding.length !== dimensions ||
        chunk.embedding.some(
          (value) =>
            !Number.isFinite(value) || !Number.isFinite(Math.fround(value))
        )
      )
      {
        throw new Error(`Inconsistent embedding dimensions for ${file.path}`)
      }
    }

    return dimensions
  }

  private fileHasCurrentEmbeddings(
    projectId: number,
    file: IndexedFile
  ): boolean
  {
    const chunkerVersion = file.chunks[0]?.chunkerVersion
    if (chunkerVersion === undefined) return false

    const row = this.db
      .prepare(
        `
        SELECT
          f.sha256 AS sha256,
          COUNT(c.id) AS chunks,
          COUNT(e.chunk_id) AS embeddings
        FROM files f
        LEFT JOIN chunks c
          ON c.file_id = f.id AND c.chunker_version = ?
        LEFT JOIN embeddings e ON e.chunk_id = c.id
        WHERE f.project_id = ? AND f.path = ?
        GROUP BY f.id
      `
      )
      .get(chunkerVersion, projectId, file.path) as CurrentFileRow | undefined

    return (
      row?.sha256 === file.sha256 &&
      row.chunks === file.chunks.length &&
      row.embeddings === file.chunks.length
    )
  }

  private bindDimensions(dimensions: number): void
  {
    const current = this.metadata().embedding_dimensions
    if (current === null)
    {
      this.db
        .prepare(
          `
          UPDATE cache_metadata
          SET embedding_dimensions = ?
          WHERE singleton = 1 AND embedding_dimensions IS NULL
        `
        )
        .run(dimensions)
      return
    }

    if (current !== dimensions)
    {
      throw new Error(
        `Embedding dimension mismatch for space ${this.space.id}: expected ${current}, got ${dimensions}`
      )
    }
  }

  private now(): string
  {
    return new Date().toISOString()
  }

  ensureProject(cwd: string): number
  {
    return this.withBusyContext('opening the project index', () =>
    {
      const now = this.now()
      const row = this.db
        .prepare(
          `
          INSERT INTO projects (cwd, created_at, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(cwd) DO UPDATE SET updated_at = excluded.updated_at
          RETURNING id
        `
        )
        .get(resolve(cwd), now, now) as IdRow | undefined

      if (!row) throw new Error('Failed to create retrieval project')
      return row.id
    })
  }

  listFiles(
    projectId: number,
    chunkerVersion: number
  ): Map<string, IndexedFileStatus>
  {
    return this.withBusyContext('reading indexed file metadata', () =>
    {
      const rows = this.db
        .prepare(
          `
        SELECT
          f.path AS path,
          f.size AS size,
          f.mtime_ms AS mtime_ms,
          f.ctime_ms AS ctime_ms,
          f.sha256 AS sha256,
          COUNT(c.id) AS chunks,
          COUNT(e.chunk_id) AS embeddings
        FROM files f
        LEFT JOIN chunks c
          ON c.file_id = f.id AND c.chunker_version = ?
        LEFT JOIN embeddings e ON e.chunk_id = c.id
        WHERE f.project_id = ?
        GROUP BY f.id
      `
        )
        .all(chunkerVersion, projectId) as FileStatusRow[]

      const files = new Map<string, IndexedFileStatus>()
      for (const row of rows)
      {
        files.set(row.path, {
          size: row.size,
          mtimeMs: row.mtime_ms,
          ctimeMs: row.ctime_ms,
          sha256: row.sha256,
          embeddingsCurrent: row.chunks > 0 && row.chunks === row.embeddings,
        })
      }

      return files
    })
  }

  touchFile(
    projectId: number,
    path: string,
    size: number,
    mtimeMs: number,
    ctimeMs: number,
    expected: IndexedFileStatus
  ): boolean
  {
    return this.withBusyContext('updating indexed file metadata', () =>
    {
      const result = this.db
        .prepare(
          `
          UPDATE files
          SET size = ?, mtime_ms = ?, ctime_ms = ?, indexed_at = ?
          WHERE
            project_id = ? AND
            path = ? AND
            size = ? AND
            mtime_ms = ? AND
            ctime_ms = ? AND
            sha256 = ?
        `
        )
        .run(
          size,
          mtimeMs,
          ctimeMs,
          this.now(),
          projectId,
          path,
          expected.size,
          expected.mtimeMs,
          expected.ctimeMs,
          expected.sha256
        )
      if (result.changes === 1) return true

      const current = this.db
        .prepare('SELECT sha256 FROM files WHERE project_id = ? AND path = ?')
        .get(projectId, path) as { sha256: string } | undefined
      return current?.sha256 === expected.sha256
    })
  }

  upsertFile(
    projectId: number,
    file: IndexedFile,
    expected: IndexedFileStatus | undefined
  ): boolean
  {
    if (file.chunks.length === 0)
    {
      throw new Error(`Cannot upsert ${file.path} without chunks`)
    }
    const dimensions = this.dimensionsFor(file)

    const write = this.db.transaction((): boolean =>
    {
      this.bindDimensions(dimensions)
      const now = this.now()
      const fileRow = expected
        ? (this.db
            .prepare(
              `
              UPDATE files
              SET
                size = ?,
                mtime_ms = ?,
                ctime_ms = ?,
                sha256 = ?,
                indexed_at = ?
              WHERE
                project_id = ? AND
                path = ? AND
                size = ? AND
                mtime_ms = ? AND
                ctime_ms = ? AND
                sha256 = ?
              RETURNING id
            `
            )
            .get(
              file.size,
              file.mtimeMs,
              file.ctimeMs,
              file.sha256,
              now,
              projectId,
              file.path,
              expected.size,
              expected.mtimeMs,
              expected.ctimeMs,
              expected.sha256
            ) as IdRow | undefined)
        : (this.db
            .prepare(
              `
          INSERT INTO files (
            project_id,
            path,
            size,
            mtime_ms,
            ctime_ms,
            sha256,
            indexed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, path) DO NOTHING
          RETURNING id
        `
            )
            .get(
              projectId,
              file.path,
              file.size,
              file.mtimeMs,
              file.ctimeMs,
              file.sha256,
              now
            ) as IdRow | undefined)

      if (!fileRow) return this.fileHasCurrentEmbeddings(projectId, file)

      this.db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileRow.id)

      const insertChunk = this.db.prepare(`
        INSERT INTO chunks (
          file_id,
          chunk_index,
          start_line,
          end_line,
          text,
          chunker_version
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      const insertEmbedding = this.db.prepare(`
        INSERT INTO embeddings (chunk_id, dims, vector)
        VALUES (?, ?, ?)
      `)

      for (const chunk of file.chunks)
      {
        const chunkResult = insertChunk.run(
          fileRow.id,
          chunk.chunkIndex,
          chunk.startLine,
          chunk.endLine,
          chunk.text,
          chunk.chunkerVersion
        )

        insertEmbedding.run(
          Number(chunkResult.lastInsertRowid),
          dimensions,
          vectorToBlob(chunk.embedding)
        )
      }

      return true
    })

    return this.withBusyContext(`upserting ${file.path}`, () =>
      write.immediate()
    )
  }

  deleteFile(
    projectId: number,
    path: string,
    expected: IndexedFileStatus | undefined
  ): boolean
  {
    if (!expected) return true
    return this.withBusyContext(`deleting ${path} from the index`, () =>
    {
      const result = this.db
        .prepare(
          `
          DELETE FROM files
          WHERE
            project_id = ? AND
            path = ? AND
            size = ? AND
            mtime_ms = ? AND
            ctime_ms = ? AND
            sha256 = ?
        `
        )
        .run(
          projectId,
          path,
          expected.size,
          expected.mtimeMs,
          expected.ctimeMs,
          expected.sha256
        )
      if (result.changes === 1) return true

      const current = this.db
        .prepare('SELECT 1 FROM files WHERE project_id = ? AND path = ?')
        .get(projectId, path)
      return current === undefined
    })
  }

  deleteMissingFiles(
    projectId: number,
    currentPaths: Set<string>,
    expectedFiles: Map<string, IndexedFileStatus>
  ): boolean
  {
    const removeMissing = this.db.transaction((): boolean =>
    {
      const stale = [...expectedFiles].filter(
        ([path]) => !currentPaths.has(path)
      )
      if (stale.length === 0) return true

      const remove = this.db.prepare(
        `
        DELETE FROM files
        WHERE
          project_id = ? AND
          path = ? AND
          size = ? AND
          mtime_ms = ? AND
          ctime_ms = ? AND
          sha256 = ?
      `
      )
      let allCurrent = true
      for (const [path, expected] of stale)
      {
        const result = remove.run(
          projectId,
          path,
          expected.size,
          expected.mtimeMs,
          expected.ctimeMs,
          expected.sha256
        )
        if (result.changes === 1) continue

        const current = this.db
          .prepare('SELECT 1 FROM files WHERE project_id = ? AND path = ?')
          .get(projectId, path)
        if (current !== undefined) allCurrent = false
      }
      return allCurrent
    })

    return this.withBusyContext('removing stale project files', () =>
      removeMissing.immediate()
    )
  }

  search(projectId: number, queryVector: number[], limit: number): SearchHit[]
  {
    return this.withBusyContext('searching the project index', () =>
    {
      const expectedDimensions = this.metadata().embedding_dimensions
      if (expectedDimensions === null) return []
      if (queryVector.length !== expectedDimensions)
      {
        throw new Error(
          `Embedding dimension mismatch for space ${this.space.id}: expected ${expectedDimensions}, got ${queryVector.length}`
        )
      }
      if (
        queryVector.some(
          (value) =>
            !Number.isFinite(value) || !Number.isFinite(Math.fround(value))
        )
      )
      {
        throw new Error(
          `Embedding query for space ${this.space.id} contains invalid numeric values`
        )
      }

      const rows = this.db
        .prepare(
          `
        SELECT
          f.path AS path,
          c.start_line AS start_line,
          c.end_line AS end_line,
          c.text AS text,
          e.dims AS dims,
          e.vector AS vector
        FROM embeddings e
        JOIN chunks c ON c.id = e.chunk_id
        JOIN files f ON f.id = c.file_id
        WHERE f.project_id = ?
      `
        )
        .all(projectId) as SearchRow[]

      return rows
        .map((row) =>
        {
          const vector = blobToVector(row.vector, row.dims)
          if (
            row.dims !== expectedDimensions ||
            vector.length === 0 ||
            vector.some((value) => !Number.isFinite(value))
          )
          {
            throw new Error(
              `Corrupt embedding vector in retrieval space ${this.space.id}`
            )
          }

          return {
            path: row.path,
            startLine: row.start_line,
            endLine: row.end_line,
            score: cosineSimilarity(queryVector, vector),
            text: row.text,
          }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    })
  }

  close(): void
  {
    this.db.close()
  }
}
