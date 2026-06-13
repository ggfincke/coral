// src/retrieval/sqlite-store.ts
// SQLite-backed semantic code index

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getCoralHome } from '../utils/coral-home.js'
import { blobToVector, cosineSimilarity, vectorToBlob } from './vector.js'
import type {
  IndexedFile,
  IndexedFileStatus,
  IndexStore,
  SearchHit,
} from './types.js'

interface IdRow
{
  id: number
}

interface FileStatusRow
{
  path: string
  size: number
  mtime_ms: number
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

function defaultDbPath(): string
{
  return join(getCoralHome(), 'retrieval', 'index.sqlite')
}

export class SqliteIndexStore implements IndexStore
{
  private db: Database.Database

  constructor(path = defaultDbPath())
  {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void
  {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY,
        cwd TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        sha256 TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE(project_id, path)
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        chunker_version INTEGER NOT NULL,
        UNIQUE(file_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY(chunk_id, model)
      );

      CREATE INDEX IF NOT EXISTS idx_files_project
        ON files(project_id);

      CREATE INDEX IF NOT EXISTS idx_embeddings_model
        ON embeddings(model);
    `)
  }

  // current timestamp for row created_at/updated_at columns
  private now(): string
  {
    return new Date().toISOString()
  }

  ensureProject(cwd: string): number
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
      .get(cwd, now, now) as IdRow | undefined

    if (!row) throw new Error('Failed to create retrieval project')
    return row.id
  }

  listFiles(
    projectId: number,
    model: string,
    chunkerVersion: number
  ): Map<string, IndexedFileStatus>
  {
    const rows = this.db
      .prepare(
        `
        SELECT
          f.path AS path,
          f.size AS size,
          f.mtime_ms AS mtime_ms,
          f.sha256 AS sha256,
          COUNT(c.id) AS chunks,
          COUNT(e.chunk_id) AS embeddings
        FROM files f
        LEFT JOIN chunks c
          ON c.file_id = f.id AND c.chunker_version = ?
        LEFT JOIN embeddings e
          ON e.chunk_id = c.id AND e.model = ?
        WHERE f.project_id = ?
        GROUP BY f.id
      `
      )
      .all(chunkerVersion, model, projectId) as FileStatusRow[]

    const files = new Map<string, IndexedFileStatus>()
    for (const row of rows)
    {
      files.set(row.path, {
        size: row.size,
        mtimeMs: row.mtime_ms,
        sha256: row.sha256,
        embeddingsCurrent: row.chunks > 0 && row.chunks === row.embeddings,
      })
    }

    return files
  }

  touchFile(
    projectId: number,
    path: string,
    size: number,
    mtimeMs: number
  ): void
  {
    this.db
      .prepare(
        `
        UPDATE files
        SET size = ?, mtime_ms = ?, indexed_at = ?
        WHERE project_id = ? AND path = ?
      `
      )
      .run(size, mtimeMs, this.now(), projectId, path)
  }

  upsertFile(projectId: number, file: IndexedFile, model: string): void
  {
    // a chunk-less file has no place in the index; never write an orphan
    // files row (the indexer also filters empties before calling here)
    if (file.chunks.length === 0) return

    const write = this.db.transaction(() =>
    {
      const now = this.now()
      const fileRow = this.db
        .prepare(
          `
          INSERT INTO files (
            project_id,
            path,
            size,
            mtime_ms,
            sha256,
            indexed_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, path) DO UPDATE SET
            size = excluded.size,
            mtime_ms = excluded.mtime_ms,
            sha256 = excluded.sha256,
            indexed_at = excluded.indexed_at
          RETURNING id
        `
        )
        .get(
          projectId,
          file.path,
          file.size,
          file.mtimeMs,
          file.sha256,
          now
        ) as IdRow | undefined

      if (!fileRow) throw new Error(`Failed to upsert ${file.path}`)

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
        INSERT INTO embeddings (chunk_id, model, dims, vector)
        VALUES (?, ?, ?, ?)
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
          model,
          chunk.embedding.length,
          vectorToBlob(chunk.embedding)
        )
      }
    })

    write()
  }

  deleteFile(projectId: number, path: string): void
  {
    this.db
      .prepare('DELETE FROM files WHERE project_id = ? AND path = ?')
      .run(projectId, path)
  }

  deleteMissingFiles(projectId: number, currentPaths: Set<string>): number
  {
    const rows = this.db
      .prepare('SELECT path FROM files WHERE project_id = ?')
      .all(projectId) as { path: string }[]
    const stale = rows.filter((row) => !currentPaths.has(row.path))
    if (stale.length === 0) return 0

    const remove = this.db.prepare(
      'DELETE FROM files WHERE project_id = ? AND path = ?'
    )

    this.db.transaction(() =>
    {
      for (const row of stale)
      {
        remove.run(projectId, row.path)
      }
    })()

    return stale.length
  }

  search(
    projectId: number,
    model: string,
    queryVector: number[],
    limit: number
  ): SearchHit[]
  {
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
        WHERE f.project_id = ? AND e.model = ?
      `
      )
      .all(projectId, model) as SearchRow[]

    return rows
      .map((row) => ({
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: cosineSimilarity(
          queryVector,
          blobToVector(row.vector, row.dims)
        ),
        text: row.text,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  close(): void
  {
    this.db.close()
  }
}
