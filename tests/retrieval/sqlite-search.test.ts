// tests/retrieval/sqlite-search.test.ts
// exact bounded ranking and snapshot-safe winner hydration

import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { createEmbeddingSpace } from '../../src/retrieval/embedding-space.js'
import { SqliteIndexStore } from '../../src/retrieval/sqlite-store.js'
import { CHUNKER_VERSION, type IndexedFile } from '../../src/retrieval/types.js'
import { vectorToBlob } from '../../src/retrieval/vector.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

test('SQLite ranks exact stable winners without hydrating losers or mixing reindex snapshots', async (t) =>
{
  const dir = await tempDir('coral-retrieval-search-')
  const path = join(dir, 'index.sqlite')
  const space = createEmbeddingSpace('http://ollama.test', {
    model: 'test-embed:latest',
    digest: 'a'.repeat(64),
  })
  const reader = new SqliteIndexStore(space, path)
  const writer = new SqliteIndexStore(space, path)
  const raw = new Database(path)
  const projectId = reader.ensureProject(dir)
  const chunksByFile: [string, [number, number[]][]][] = [
    [
      'z.ts',
      [
        [2, [1, 0]],
        [0, [0, 1]],
        [1, [3, 4]],
      ],
    ],
    [
      'a.ts',
      [
        [1, [0, -1]],
        [0, [1, 0]],
      ],
    ],
    [
      'Z.ts',
      [
        [1, [1, 0]],
        [0, [1, 0]],
      ],
    ],
  ]
  const files: IndexedFile[] = chunksByFile.map(([filePath, values]) => ({
    path: filePath,
    size: 100,
    mtimeMs: 1,
    ctimeMs: 1,
    sha256: `original-${filePath}`,
    chunks: values.map(([chunkIndex, embedding]) => ({
      chunkIndex,
      startLine: chunkIndex * 10 + 1,
      endLine: chunkIndex * 10 + 3,
      text: `${filePath}:${chunkIndex}:original`,
      chunkerVersion: CHUNKER_VERSION,
      embedding,
    })),
  }))

  try
  {
    for (const file of files)
      assert.equal(writer.upsertFile(projectId, file, undefined), true)
    const reference = files
      .flatMap((file) =>
        file.chunks.map((chunk) => ({
          path: file.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          score: chunk.embedding[0] / Math.hypot(...chunk.embedding),
        }))
      )
      .sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine
      )
      .sort((a, b) => b.score - a.score)

    let textRows = 0
    let beforeTextRead: (() => void) | undefined
    const prepare = Database.prototype.prepare
    t.mock.method(
      Database.prototype,
      'prepare',
      function (this: Database.Database, sql: string)
      {
        const statement = prepare.call(this, sql)
        if (
          !statement.reader ||
          !statement.columns().some((column) => column.name === 'text')
        )
          return statement
        const noteRows = (rows: unknown[]) =>
        {
          textRows += rows.filter((row) => row !== undefined).length
        }
        const beforeRead = () =>
        {
          const run = beforeTextRead
          beforeTextRead = undefined
          run?.()
        }
        const get = statement.get.bind(statement)
        const all = statement.all.bind(statement)
        const iterate = statement.iterate.bind(statement)
        t.mock.method(statement, 'get', (...args: unknown[]) =>
        {
          beforeRead()
          const row = get(...args)
          noteRows([row])
          return row
        })
        t.mock.method(statement, 'all', (...args: unknown[]) =>
        {
          beforeRead()
          const rows = all(...args)
          noteRows(rows)
          return rows
        })
        t.mock.method(statement, 'iterate', function* (...args: unknown[])
        {
          beforeRead()
          for (const row of iterate(...args))
          {
            noteRows([row])
            yield row
          }
        })
        return statement
      }
    )

    assert.deepEqual(reader.search(projectId, [1, 0], 5), reference.slice(0, 5))
    assert.equal(textRows, 5)
    assert.deepEqual(
      reference.slice(0, 4).map((hit) => hit.text),
      [
        'Z.ts:0:original',
        'Z.ts:1:original',
        'a.ts:0:original',
        'z.ts:2:original',
      ]
    )

    const prior = writer.listFiles(projectId, CHUNKER_VERSION).get('Z.ts')
    let reindexed = false
    beforeTextRead = () =>
    {
      const original = files.find((file) => file.path === 'Z.ts')!
      assert.equal(
        writer.upsertFile(
          projectId,
          {
            ...original,
            mtimeMs: 2,
            ctimeMs: 2,
            sha256: 'reindexed-Z.ts',
            chunks: original.chunks.map((chunk) => ({
              ...chunk,
              text: chunk.text.replace('original', 'reindexed'),
              embedding: [0, 1],
            })),
          },
          prior
        ),
        true
      )
      reindexed = true
    }
    textRows = 0
    assert.deepEqual(reader.search(projectId, [1, 0], 3), reference.slice(0, 3))
    assert.equal(reindexed, true)
    assert.equal(textRows, 3)
    assert.deepEqual(
      reader.search(projectId, [1, 0], 3),
      reference.filter((hit) => hit.path !== 'Z.ts').slice(0, 3)
    )

    const corruptLosingVector = raw.prepare(`
      UPDATE embeddings SET vector = ?
      WHERE chunk_id = (
        SELECT c.id FROM chunks c JOIN files f ON f.id = c.file_id
        WHERE f.path = 'z.ts' AND c.chunk_index = 0
      )
    `)
    corruptLosingVector.run(Buffer.from([0]))
    textRows = 0
    assert.throws(
      () => reader.search(projectId, [1, 0], 1),
      /Corrupt embedding vector/
    )
    assert.throws(
      () => reader.search(projectId, [1, 0], 0),
      /Corrupt embedding vector/
    )
    assert.equal(textRows, 0)
    assert.throws(
      () => reader.search(projectId, [1], 1),
      /Embedding dimension mismatch/
    )
    assert.throws(
      () => reader.search(projectId, [Number.NaN, 0], 1),
      /contains invalid numeric values/
    )
    corruptLosingVector.run(vectorToBlob([0, 1]))
    assert.equal(
      reader.search(projectId, [1, 0], 1)[0]?.text,
      'a.ts:0:original'
    )
  }
  finally
  {
    raw.close()
    writer.close()
    reader.close()
  }
})
