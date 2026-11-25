// tests/retrieval/refresh-resilience.test.ts
// tests that one unreadable or constantly rewritten file cannot fail a refresh

import { strict as assert } from 'node:assert'
import { appendFile, chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createEmbeddingSpace } from '../../src/retrieval/embedding-space.js'
import { ProjectIndexer } from '../../src/retrieval/indexer.js'
import { SqliteIndexStore } from '../../src/retrieval/sqlite-store.js'
import { CHUNKER_VERSION, type Embedder } from '../../src/retrieval/types.js'
import { keywordVector } from '../helpers/embed.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()
const space = createEmbeddingSpace('http://ollama.test', {
  model: 'test-embed:latest',
  digest: 'a'.repeat(64),
})

// keyword embedder w/ an optional hook that runs before each batch
function makeEmbedder(beforeEmbed?: () => Promise<void>): Embedder
{
  return {
    space,
    async embed(texts)
    {
      await beforeEmbed?.()
      return texts.map((text) => keywordVector(text))
    },
  }
}

async function makeProject(prefix: string): Promise<string>
{
  const dir = await tempDir(prefix)
  await writeFile(
    join(dir, 'auth.ts'),
    'export function loginSession() {\n  return "auth";\n}\n'
  )
  return dir
}

test(
  'ProjectIndexer skips an unreadable file and drops its stale rows',
  { skip: process.getuid?.() === 0 && 'root ignores file modes' },
  async () =>
  {
    const dir = await makeProject('coral-retrieval-unreadable-')
    const secret = join(dir, 'secret.ts')
    await writeFile(secret, 'export const key = 1\n')

    const store = new SqliteIndexStore(space, join(dir, 'index.sqlite'))
    const indexer = new ProjectIndexer(dir, makeEmbedder(), store)
    const indexedPaths = () =>
      store.listFiles(store.ensureProject(dir), CHUNKER_VERSION)

    try
    {
      await indexer.ensureIndexed()
      assert.ok(indexedPaths().has('secret.ts'))

      await chmod(secret, 0o000)
      const stats = await indexer.ensureIndexed()
      assert.deepEqual(stats.skippedFiles, ['secret.ts'])
      assert.equal(indexedPaths().has('secret.ts'), false)

      const hits = await indexer.search('session auth', 1)
      assert.equal(hits[0]?.path, 'auth.ts')
    }
    finally
    {
      await chmod(secret, 0o600)
      store.close()
    }
  }
)

test('ProjectIndexer skips a file that keeps changing and keeps its old row', async () =>
{
  const dir = await makeProject('coral-retrieval-busy-file-')
  const log = join(dir, 'dev.log')
  await writeFile(log, 'server started\n')

  // once enabled, every embed call rewrites the log before the commit check
  let rewriting = false
  const embedder = makeEmbedder(async () =>
  {
    if (rewriting) await appendFile(log, `request ${Date.now()}\n`)
  })
  const store = new SqliteIndexStore(space, join(dir, 'index.sqlite'))
  const indexer = new ProjectIndexer(dir, embedder, store)

  try
  {
    await indexer.ensureIndexed()
    const before = store
      .listFiles(store.ensureProject(dir), CHUNKER_VERSION)
      .get('dev.log')
    assert.ok(before)

    rewriting = true
    await appendFile(log, 'listening\n')
    const stats = await indexer.ensureIndexed()
    assert.deepEqual(stats.skippedFiles, ['dev.log'])
    assert.deepEqual(
      store.listFiles(store.ensureProject(dir), CHUNKER_VERSION).get('dev.log'),
      before
    )

    const hits = await indexer.search('session auth', 1)
    assert.equal(hits[0]?.path, 'auth.ts')
  }
  finally
  {
    store.close()
  }
})
