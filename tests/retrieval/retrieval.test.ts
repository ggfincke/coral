// tests/retrieval/retrieval.test.ts
// tests for semantic retrieval indexing

import { strict as assert } from 'node:assert'
import {
  mkdir,
  readFile,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { chunkText } from '../../src/retrieval/chunker.js'
import { createEmbeddingSpace } from '../../src/retrieval/embedding-space.js'
import { collectIndexableFiles } from '../../src/retrieval/files.js'
import { ProjectIndexer } from '../../src/retrieval/indexer.js'
import {
  embeddingSpaceDbPath,
  RETRIEVAL_APPLICATION_ID,
  RETRIEVAL_SCHEMA_VERSION,
  SqliteIndexStore,
} from '../../src/retrieval/sqlite-store.js'
import {
  CHUNKER_VERSION,
  type Embedder,
  type EmbeddingSpace,
  type IndexedFile,
} from '../../src/retrieval/types.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { keywordVector } from '../helpers/embed.js'
import { HAS_GIT, initTestRepo } from '../helpers/git.js'

const { tempDir } = makeTempDirPool()

function makeSpace(
  digestChar = 'a',
  host = 'http://ollama.test',
  model = 'test-embed:latest'
): EmbeddingSpace
{
  return createEmbeddingSpace(host, {
    model,
    digest: digestChar.repeat(64),
  })
}

class KeywordEmbedder implements Embedder
{
  embeddedTexts: string[] = []

  constructor(public space = makeSpace())
  {}

  async embed(texts: string[]): Promise<number[][]>
  {
    this.embeddedTexts.push(...texts)
    return texts.map((text) => keywordVector(text))
  }
}

class PausedEmbedder extends KeywordEmbedder
{
  private releaseEmbed!: () => void
  private enteredEmbed!: () => void
  private released = false

  entered = new Promise<void>((resolve) =>
  {
    this.enteredEmbed = resolve
  })

  private releasedPromise = new Promise<void>((resolve) =>
  {
    this.releaseEmbed = resolve
  })

  release(): void
  {
    this.released = true
    this.releaseEmbed()
  }

  override async embed(texts: string[]): Promise<number[][]>
  {
    this.enteredEmbed()
    if (!this.released) await this.releasedPromise
    return super.embed(texts)
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

  const space = makeSpace()
  const store = new SqliteIndexStore(space, join(dir, 'index.sqlite'))
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

test('ProjectIndexer.ensureIndexed reports progress, stats, and idempotency', async () =>
{
  const dir = await tempDir('coral-retrieval-ensure-')
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

  const space = makeSpace()
  const store = new SqliteIndexStore(space, join(dir, 'index.sqlite'))
  const embedder = new KeywordEmbedder()
  const indexer = new ProjectIndexer(dir, embedder, store)

  try
  {
    const progress: number[] = []
    const first = await indexer.ensureIndexed({
      onProgress: (p) =>
      {
        progress.push(p.processed)
        assert.equal(p.total, 2)
      },
    })

    assert.deepEqual(progress, [1, 2])
    assert.equal(first.totalFiles, 2)
    assert.equal(first.embeddedFiles, 2)
    assert.ok(first.chunks >= 2)
    const embeddedAfterFirst = embedder.embeddedTexts.length

    // second pass embeds nothing — every file is already current
    const second = await indexer.ensureIndexed()
    assert.equal(second.embeddedFiles, 0)
    assert.equal(embedder.embeddedTexts.length, embeddedAfterFirst)

    // force re-embeds every file
    const forced = await indexer.ensureIndexed({ force: true })
    assert.equal(forced.embeddedFiles, 2)
    assert.equal(embedder.embeddedTexts.length, embeddedAfterFirst * 2)
  }
  finally
  {
    store.close()
  }
})

test('collectIndexableFiles respects git excludes before fallback ignores', async (t) =>
{
  if (!HAS_GIT)
  {
    t.skip('git is required for git-exclude discovery')
    return
  }

  const dir = await tempDir('coral-retrieval-git-files-')
  initTestRepo(dir)

  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, '.coral'), { recursive: true })
  await mkdir(join(dir, '.coral-retrieval'), { recursive: true })
  await mkdir(join(dir, 'reference'), { recursive: true })
  await mkdir(join(dir, 'dev-docs'), { recursive: true })
  await writeFile(
    join(dir, '.git', 'info', 'exclude'),
    'reference/\ndev-docs/\n'
  )
  await writeFile(join(dir, 'src', 'app.ts'), 'export const app = true\n')
  await writeFile(join(dir, '.coral', 'session.txt'), 'local session\n')
  await writeFile(
    join(dir, '.coral-retrieval', 'index.sqlite'),
    'local index\n'
  )
  await writeFile(
    join(dir, 'reference', 'upstream.ts'),
    'export const ignored = true\n'
  )
  await writeFile(join(dir, 'dev-docs', 'note.md'), '# ignored\n')

  const files = await collectIndexableFiles(dir, () => false)

  assert.deepEqual(
    files.changed.map((file) => file.path),
    ['src/app.ts']
  )
})

test('collectIndexableFiles counts accepted text files instead of binary candidates', async () =>
{
  const dir = await tempDir('coral-retrieval-cap-')
  await mkdir(join(dir, 'src'), { recursive: true })

  await writeFile(join(dir, 'src', 'binary-candidate.ts'), Buffer.from([0, 1]))

  for (let i = 0; i < 2001; i++)
  {
    await writeFile(
      join(dir, 'src', `file-${String(i).padStart(4, '0')}.ts`),
      `export const value${i} = ${i}\n`
    )
  }

  const files = await collectIndexableFiles(
    dir,
    (file) => file.path === 'src/file-0000.ts'
  )

  assert.equal(files.changed.length + files.unchangedPaths.length, 2000)
  assert.deepEqual(files.unchangedPaths, ['src/file-0000.ts'])
  assert.deepEqual(
    files.changed.slice(0, 3).map((file) => file.path),
    ['src/file-0001.ts', 'src/file-0002.ts', 'src/file-0003.ts']
  )
  assert.equal(
    files.changed.some((file) => file.path === 'src/file-2000.ts'),
    false
  )
})

test('collectIndexableFiles fallback skips noisy, unsafe, and non-text files', async () =>
{
  const dir = await tempDir('coral-retrieval-fallback-')
  await mkdir(join(dir, '.coral'), { recursive: true })
  await mkdir(join(dir, '.coral-retrieval'), { recursive: true })
  await mkdir(join(dir, '.git'), { recursive: true })
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await mkdir(join(dir, 'src'), { recursive: true })

  await writeFile(join(dir, 'src', 'app.ts'), 'export const app = true\n')
  await writeFile(join(dir, '.coral', 'session.json'), '{}\n')
  await writeFile(join(dir, '.coral-retrieval', 'index.sqlite'), 'sqlite\n')
  await writeFile(join(dir, '.git', 'config'), '[core]\n')
  await writeFile(join(dir, 'node_modules', 'pkg.js'), 'module.exports = 1\n')
  await writeFile(join(dir, 'large.ts'), 'x'.repeat(600 * 1024))
  await writeFile(join(dir, 'binary.dat'), Buffer.from([0, 1, 2]))
  await symlink(join(dir, 'src', 'app.ts'), join(dir, 'linked.ts'))

  const files = await collectIndexableFiles(dir, () => false)

  assert.deepEqual(
    files.changed.map((file) => file.path),
    ['src/app.ts']
  )
})

test('ProjectIndexer shares concurrent refreshes for a project and model', async () =>
{
  const dir = await tempDir('coral-retrieval-dedupe-')
  await writeFile(
    join(dir, 'auth.ts'),
    'export function loginSession() {\n  return "auth session";\n}\n',
    'utf-8'
  )

  const dbPath = join(dir, 'index.sqlite')
  const space = makeSpace()
  const storeA = new SqliteIndexStore(space, dbPath)
  const storeB = new SqliteIndexStore(space, dbPath)
  const embedderA = new PausedEmbedder()
  const embedderB = new KeywordEmbedder()
  const indexerA = new ProjectIndexer(dir, embedderA, storeA)
  const indexerB = new ProjectIndexer(dir, embedderB, storeB)

  try
  {
    const first = indexerA.ensureIndexed()
    await embedderA.entered
    const second = indexerB.ensureIndexed()

    embedderA.release()
    const [firstStats, secondStats] = await Promise.all([first, second])

    assert.equal(firstStats.embeddedFiles, 1)
    assert.equal(secondStats.embeddedFiles, 1)
    assert.deepEqual(embedderB.embeddedTexts, [])

    const hits = await indexerB.search('auth session', 1)
    assert.equal(hits[0]?.path, 'auth.ts')
    assert.deepEqual(embedderB.embeddedTexts, ['auth session'])
  }
  finally
  {
    embedderA.release()
    storeA.close()
    storeB.close()
  }
})

test('embedding spaces isolate hosts and artifacts while preserving A-B-A reuse', async () =>
{
  const dir = await tempDir('coral-retrieval-spaces-')
  const file = join(dir, 'feature.ts')
  await writeFile(file, 'export const feature = "first"\n')

  const spaces = [
    makeSpace('a', 'http://ollama-a.test', 'same-tag:latest'),
    makeSpace('a', 'http://ollama-b.test', 'same-tag:latest'),
    makeSpace('b', 'http://ollama-a.test', 'same-tag:latest'),
  ]
  assert.equal(new Set(spaces.map((space) => space.id)).size, 3)

  const stores = spaces.map(
    (space) =>
      new SqliteIndexStore(space, join(dir, 'cache', `${space.id}.sqlite`))
  )
  const embedders = spaces.map((space) => new KeywordEmbedder(space))
  const indexers = spaces.map(
    (space, index) => new ProjectIndexer(dir, embedders[index]!, stores[index]!)
  )

  try
  {
    assert.equal((await indexers[0]!.ensureIndexed()).embeddedFiles, 1)
    assert.equal((await indexers[1]!.ensureIndexed()).embeddedFiles, 1)
    assert.equal((await indexers[0]!.ensureIndexed()).embeddedFiles, 0)
    assert.equal((await indexers[2]!.ensureIndexed()).embeddedFiles, 1)
    assert.equal((await indexers[0]!.ensureIndexed()).embeddedFiles, 0)

    await writeFile(file, 'export const feature = "changed content"\n')

    for (const indexer of indexers)
    {
      assert.equal((await indexer.ensureIndexed()).embeddedFiles, 1)
    }
    assert.equal((await indexers[0]!.ensureIndexed()).embeddedFiles, 0)
  }
  finally
  {
    for (const store of stores) store.close()
  }
})

test('different embedding spaces never share an in-process refresh', async () =>
{
  const dir = await tempDir('coral-retrieval-space-coalescing-')
  await writeFile(dir + '/feature.ts', 'export const feature = true\n')

  const spaceA = makeSpace('a', 'http://ollama-a.test', 'same-tag:latest')
  const spaceB = makeSpace('a', 'http://ollama-b.test', 'same-tag:latest')
  const storeA = new SqliteIndexStore(spaceA, join(dir, 'a.sqlite'))
  const storeB = new SqliteIndexStore(spaceB, join(dir, 'b.sqlite'))
  const embedderA = new PausedEmbedder(spaceA)
  const embedderB = new PausedEmbedder(spaceB)
  const indexerA = new ProjectIndexer(dir, embedderA, storeA)
  const indexerB = new ProjectIndexer(dir, embedderB, storeB)

  try
  {
    const first = indexerA.ensureIndexed()
    await embedderA.entered
    const second = indexerB.ensureIndexed()
    let timer: NodeJS.Timeout | undefined
    try
    {
      await Promise.race([
        embedderB.entered,
        new Promise<never>((_resolve, reject) =>
        {
          timer = setTimeout(
            () => reject(new Error('different embedding space was coalesced')),
            1_000
          )
        }),
      ])
    }
    finally
    {
      if (timer) clearTimeout(timer)
    }

    embedderA.release()
    embedderB.release()
    const stats = await Promise.all([first, second])
    assert.deepEqual(
      stats.map((value) => value.embeddedFiles),
      [1, 1]
    )
  }
  finally
  {
    embedderA.release()
    embedderB.release()
    storeA.close()
    storeB.close()
  }
})

test('ProjectIndexer discards embeddings when source bytes change in flight', async () =>
{
  const dir = await tempDir('coral-retrieval-source-race-')
  const path = join(dir, 'feature.ts')
  await writeFile(path, 'export const feature = "old auth"\n')

  const space = makeSpace()
  const store = new SqliteIndexStore(space, join(dir, 'index.sqlite'))
  const embedder = new PausedEmbedder(space)
  const indexer = new ProjectIndexer(dir, embedder, store)

  try
  {
    const indexing = indexer.ensureIndexed()
    await embedder.entered
    await writeFile(path, 'export const feature = "new session content"\n')
    embedder.release()

    const stats = await indexing
    assert.equal(stats.embeddedFiles, 1)

    const hits = await indexer.search('new session', 1)
    assert.equal(hits[0]?.path, 'feature.ts')
    assert.match(hits[0]?.text ?? '', /new session content/)
    assert.doesNotMatch(hits[0]?.text ?? '', /old auth/)
  }
  finally
  {
    embedder.release()
    store.close()
  }
})

test('SqliteIndexStore rejects stale writes and deletes after a newer commit', async () =>
{
  const dir = await tempDir('coral-retrieval-stale-write-')
  const space = makeSpace()
  const dbPath = join(dir, 'index.sqlite')
  const storeA = new SqliteIndexStore(space, dbPath)
  const storeB = new SqliteIndexStore(space, dbPath)
  const projectA = storeA.ensureProject(dir)
  const projectB = storeB.ensureProject(dir)
  const oldFile: IndexedFile = {
    path: 'feature.ts',
    size: 3,
    mtimeMs: 1,
    ctimeMs: 1,
    sha256: 'old-content',
    chunks: [
      {
        chunkIndex: 0,
        startLine: 1,
        endLine: 1,
        text: 'old auth',
        chunkerVersion: CHUNKER_VERSION,
        embedding: keywordVector('old auth'),
      },
    ],
  }
  const newFile: IndexedFile = {
    ...oldFile,
    size: 11,
    mtimeMs: 2,
    ctimeMs: 2,
    sha256: 'new-content',
    chunks: [
      {
        ...oldFile.chunks[0]!,
        text: 'new session',
        embedding: keywordVector('new session'),
      },
    ],
  }

  try
  {
    assert.equal(storeA.upsertFile(projectA, oldFile, undefined), true)
    const staleSnapshot = storeA.listFiles(projectA, CHUNKER_VERSION)
    const currentSnapshot = storeB.listFiles(projectB, CHUNKER_VERSION)

    assert.equal(
      storeB.upsertFile(projectB, newFile, currentSnapshot.get(newFile.path)),
      true
    )
    assert.equal(
      storeA.upsertFile(projectA, oldFile, staleSnapshot.get(oldFile.path)),
      false
    )
    assert.equal(
      storeA.deleteMissingFiles(projectA, new Set(), staleSnapshot),
      false
    )

    const [hit] = storeA.search(projectA, keywordVector('new session'), 1)
    assert.equal(hit?.text, 'new session')
  }
  finally
  {
    storeA.close()
    storeB.close()
  }
})

test('embedding-space paths reject inconsistent or prefixed identities', () =>
{
  const space = makeSpace()
  assert.throws(
    () => embeddingSpaceDbPath({ ...space, id: 'f'.repeat(64) }),
    /does not match its host and artifact digest/
  )
  assert.throws(
    () =>
      embeddingSpaceDbPath({
        ...space,
        artifactDigest: `sha256:${space.artifactDigest}`,
      }),
    /artifact digest must be a lowercase 64-character SHA-256 hash/
  )
})

test('SqliteIndexStore maps exhausted write contention to an actionable error', async () =>
{
  const dir = await tempDir('coral-retrieval-busy-')
  const space = makeSpace()
  const dbPath = join(dir, 'index.sqlite')
  const store = new SqliteIndexStore(space, dbPath, { busyTimeoutMs: 25 })
  const blocker = new Database(dbPath, { timeout: 25 })
  const projectId = store.ensureProject(dir)
  const file: IndexedFile = {
    path: 'feature.ts',
    size: 7,
    mtimeMs: 1,
    ctimeMs: 1,
    sha256: 'feature',
    chunks: [
      {
        chunkIndex: 0,
        startLine: 1,
        endLine: 1,
        text: 'feature',
        chunkerVersion: CHUNKER_VERSION,
        embedding: [1, 0],
      },
    ],
  }

  try
  {
    blocker.exec('BEGIN IMMEDIATE')
    assert.throws(
      () => store.upsertFile(projectId, file, undefined),
      /stayed busy or locked for 25ms.*retry the search or index command/
    )
    blocker.exec('ROLLBACK')
    assert.equal(store.upsertFile(projectId, file, undefined), true)
  }
  finally
  {
    if (blocker.inTransaction) blocker.exec('ROLLBACK')
    blocker.close()
    store.close()
  }
})

test('ProjectIndexer refreshes changed files', async () =>
{
  const dir = await tempDir('coral-retrieval-refresh-')
  const file = join(dir, 'feature.ts')
  await writeFile(file, 'export const label = "button";\n', 'utf-8')

  const space = makeSpace()
  const store = new SqliteIndexStore(space, join(dir, 'index.sqlite'))
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

test('ProjectIndexer invalidates equal-size content when mtime is restored', async () =>
{
  const dir = await tempDir('coral-retrieval-ctime-')
  const path = join(dir, 'feature.ts')
  const alpha = 'export const label = "alpha";\n'
  const bravo = 'export const label = "bravo";\n'
  const fixedTime = new Date('2026-01-02T03:04:05.000Z')
  assert.equal(Buffer.byteLength(alpha), Buffer.byteLength(bravo))

  await writeFile(path, alpha)
  await utimes(path, fixedTime, fixedTime)

  const space = makeSpace()
  const store = new SqliteIndexStore(space, join(dir, 'index.sqlite'))
  const embedder = new KeywordEmbedder(space)
  const indexer = new ProjectIndexer(dir, embedder, store)

  try
  {
    assert.equal((await indexer.ensureIndexed()).embeddedFiles, 1)
    const before = await stat(path)

    let after = before
    for (
      let attempt = 0;
      attempt < 20 && after.ctimeMs === before.ctimeMs;
      attempt++
    )
    {
      await writeFile(path, bravo)
      await utimes(path, fixedTime, fixedTime)
      after = await stat(path)
      if (after.ctimeMs === before.ctimeMs)
      {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    assert.equal(after.size, before.size)
    assert.equal(after.mtimeMs, before.mtimeMs)
    assert.notEqual(after.ctimeMs, before.ctimeMs)
    assert.equal((await indexer.ensureIndexed()).embeddedFiles, 1)

    const [hit] = await indexer.search('bravo', 1)
    assert.match(hit?.text ?? '', /bravo/)
    assert.doesNotMatch(hit?.text ?? '', /alpha/)
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

  const space = makeSpace()
  const store = new SqliteIndexStore(space, join(dir, 'index.sqlite'))
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

  const space = makeSpace()
  const store = new SqliteIndexStore(space, join(dir, 'index.sqlite'))
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
  const space = makeSpace()
  const store = new SqliteIndexStore(space, join(dir, 'index.sqlite'))
  const projectId = store.ensureProject(dir)
  const file: IndexedFile = {
    path: 'empty.ts',
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    sha256: 'empty',
    chunks: [],
  }

  try
  {
    assert.throws(
      () => store.upsertFile(projectId, file, undefined),
      /Cannot upsert empty\.ts without chunks/
    )
  }
  finally
  {
    store.close()
  }
})

test('versioned space cache preserves legacy data and validates schema metadata', async () =>
{
  const home = await tempDir('coral-retrieval-layout-')
  const previousHome = process.env.CORAL_HOME
  process.env.CORAL_HOME = home
  const legacyPath = join(home, 'retrieval', 'index.sqlite')
  await mkdir(join(home, 'retrieval'), { recursive: true })
  await writeFile(legacyPath, 'legacy cache sentinel\n')

  const space = makeSpace('c', 'HTTP://OLLAMA.TEST:80/', 'same-tag:latest')
  const path = embeddingSpaceDbPath(space)
  let store: SqliteIndexStore | undefined

  try
  {
    store = new SqliteIndexStore(space)
    const projectId = store.ensureProject(home)
    const file: IndexedFile = {
      path: 'feature.ts',
      size: 12,
      mtimeMs: 1,
      ctimeMs: 1,
      sha256: 'content',
      chunks: [
        {
          chunkIndex: 0,
          startLine: 1,
          endLine: 1,
          text: 'feature',
          chunkerVersion: CHUNKER_VERSION,
          embedding: [1, 0],
        },
      ],
    }
    store.upsertFile(projectId, file, undefined)
    assert.throws(
      () => store!.search(projectId, [1, 0, 0], 1),
      /Embedding dimension mismatch/
    )
    assert.throws(
      () => store!.search(projectId, [Number.NaN, 0], 1),
      /contains invalid numeric values/
    )

    const connection = (store as unknown as { db: Database.Database }).db
    assert.equal(connection.pragma('busy_timeout', { simple: true }), 5_000)
    assert.equal(connection.pragma('foreign_keys', { simple: true }), 1)
    assert.equal(connection.pragma('journal_mode', { simple: true }), 'wal')
    assert.equal(connection.pragma('synchronous', { simple: true }), 1)
    assert.equal(connection.pragma('trusted_schema', { simple: true }), 0)
    store.close()
    store = undefined

    assert.throws(
      () => new SqliteIndexStore(makeSpace('d'), path),
      /embedding-space metadata does not match/
    )

    assert.equal(await readFile(legacyPath, 'utf8'), 'legacy cache sentinel\n')
    assert.match(path, /\/retrieval\/v2\/spaces\/[a-f\d]{64}\.sqlite$/)
    if (process.platform !== 'win32')
    {
      assert.equal((await stat(path)).mode & 0o777, 0o600)
    }

    const db = new Database(path, { readonly: true })
    try
    {
      assert.equal(
        db.pragma('application_id', { simple: true }),
        RETRIEVAL_APPLICATION_ID
      )
      assert.equal(
        db.pragma('user_version', { simple: true }),
        RETRIEVAL_SCHEMA_VERSION
      )
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')

      const metadata = db
        .prepare(
          'SELECT space_id, normalized_host, artifact_digest, embedding_dimensions FROM cache_metadata'
        )
        .get() as {
        space_id: string
        normalized_host: string
        artifact_digest: string
        embedding_dimensions: number
      }
      assert.deepEqual(metadata, {
        space_id: space.id,
        normalized_host: 'http://ollama.test',
        artifact_digest: 'c'.repeat(64),
        embedding_dimensions: 2,
      })

      const embeddingColumns = db
        .pragma('table_info(embeddings)')
        .map((column: { name: string }) => column.name)
      assert.deepEqual(embeddingColumns, ['chunk_id', 'dims', 'vector'])

      const fileColumns = db
        .pragma('table_info(files)')
        .map((column: { name: string }) => column.name)
      assert.deepEqual(fileColumns, [
        'id',
        'project_id',
        'path',
        'size',
        'mtime_ms',
        'ctime_ms',
        'sha256',
        'indexed_at',
      ])
    }
    finally
    {
      db.close()
    }
  }
  finally
  {
    store?.close()
    if (previousHome === undefined) delete process.env.CORAL_HOME
    else process.env.CORAL_HOME = previousHome
  }
})
