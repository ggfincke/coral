// tests/retrieval.test.ts
// tests for semantic retrieval indexing

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { chunkText } from '../src/retrieval/chunker.js'
import { ProjectIndexer } from '../src/retrieval/indexer.js'
import { SqliteIndexStore } from '../src/retrieval/sqlite-store.js'
import {
  CHUNKER_VERSION,
  type Embedder,
  type IndexedFile,
} from '../src/retrieval/types.js'

const tempDirs: string[] = []

after(async () =>
{
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

async function tempDir(prefix: string): Promise<string>
{
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

class KeywordEmbedder implements Embedder
{
  model = 'test-embed'
  embeddedTexts: string[] = []

  async embed(texts: string[]): Promise<number[][]>
  {
    this.embeddedTexts.push(...texts)
    return texts.map((text) =>
      /login|auth|session/i.test(text) ? [1, 0] : [0, 1]
    )
  }
}

test('chunkText creates overlapping line-based chunks', () =>
{
  const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
    '\n'
  )
  const chunks = chunkText(content)

  assert.equal(chunks.length, 2)
  assert.deepEqual(
    chunks.map((chunk) => ({
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      chunkerVersion: chunk.chunkerVersion,
    })),
    [
      {
        startLine: 1,
        endLine: 80,
        chunkerVersion: CHUNKER_VERSION,
      },
      {
        startLine: 71,
        endLine: 100,
        chunkerVersion: CHUNKER_VERSION,
      },
    ]
  )
})

test('ProjectIndexer ranks indexed chunks and reuses current embeddings', async () =>
{
  const dir = await tempDir('coral-retrieval-')
  await writeFile(
    join(dir, 'auth.ts'),
    'export function loginSession() {\n  return "auth";\n}\n',
    'utf-8'
  )
  await writeFile(
    join(dir, 'button.ts'),
    'export function renderButton() {\n  return "button";\n}\n',
    'utf-8'
  )

  const store = new SqliteIndexStore(join(dir, 'index.sqlite'))
  const embedder = new KeywordEmbedder()
  const indexer = new ProjectIndexer(dir, embedder, store)

  try
  {
    const first = await indexer.search('session auth', 1)
    const afterFirst = embedder.embeddedTexts.length
    const second = await indexer.search('session auth', 1)

    assert.equal(first[0]?.path, 'auth.ts')
    assert.equal(second[0]?.path, 'auth.ts')
    assert.equal(embedder.embeddedTexts.length, afterFirst + 1)

    // mtime churn w/ identical content must not re-embed
    const future = new Date(Date.now() + 5_000)
    await utimes(join(dir, 'auth.ts'), future, future)

    const third = await indexer.search('session auth', 1)
    assert.equal(third[0]?.path, 'auth.ts')
    assert.equal(embedder.embeddedTexts.length, afterFirst + 2)
  }
  finally
  {
    store.close()
  }
})

test('ProjectIndexer refreshes changed files', async () =>
{
  const dir = await tempDir('coral-retrieval-refresh-')
  const file = join(dir, 'feature.ts')
  await writeFile(file, 'export const label = "button";\n', 'utf-8')

  const store = new SqliteIndexStore(join(dir, 'index.sqlite'))
  const embedder = new KeywordEmbedder()
  const indexer = new ProjectIndexer(dir, embedder, store)

  try
  {
    assert.equal((await indexer.search('button', 1))[0]?.path, 'feature.ts')

    await writeFile(file, 'export const login = "auth session";\n', 'utf-8')

    const refreshed = await indexer.search('auth session', 1)
    assert.equal(refreshed[0]?.path, 'feature.ts')
    assert.match(refreshed[0]?.text ?? '', /auth session/)
  }
  finally
  {
    store.close()
  }
})

test('ProjectIndexer removes files that become empty', async () =>
{
  const dir = await tempDir('coral-retrieval-empty-')
  const file = join(dir, 'feature.ts')
  await writeFile(file, 'export const login = "auth session";\n', 'utf-8')

  const store = new SqliteIndexStore(join(dir, 'index.sqlite'))
  const embedder = new KeywordEmbedder()
  const indexer = new ProjectIndexer(dir, embedder, store)

  try
  {
    assert.equal(
      (await indexer.search('auth session', 1))[0]?.path,
      'feature.ts'
    )

    await writeFile(file, '', 'utf-8')

    assert.deepEqual(await indexer.search('auth session', 1), [])
  }
  finally
  {
    store.close()
  }
})

test('ProjectIndexer removes deleted files from the index', async () =>
{
  const dir = await tempDir('coral-retrieval-delete-')
  const file = join(dir, 'feature.ts')
  await writeFile(file, 'export const login = "auth session";\n', 'utf-8')

  const store = new SqliteIndexStore(join(dir, 'index.sqlite'))
  const embedder = new KeywordEmbedder()
  const indexer = new ProjectIndexer(dir, embedder, store)

  try
  {
    assert.equal(
      (await indexer.search('auth session', 1))[0]?.path,
      'feature.ts'
    )

    await unlink(file)

    assert.deepEqual(await indexer.search('auth session', 1), [])
  }
  finally
  {
    store.close()
  }
})

test('SqliteIndexStore rejects zero-chunk upserts', async () =>
{
  const dir = await tempDir('coral-retrieval-zero-chunk-')
  const store = new SqliteIndexStore(join(dir, 'index.sqlite'))
  const projectId = store.ensureProject(dir)
  const file: IndexedFile = {
    path: 'empty.ts',
    size: 0,
    mtimeMs: 0,
    sha256: 'empty',
    chunks: [],
  }

  try
  {
    assert.throws(
      () => store.upsertFile(projectId, file, 'test-embed'),
      /Cannot upsert empty\.ts without chunks/
    )
  }
  finally
  {
    store.close()
  }
})
