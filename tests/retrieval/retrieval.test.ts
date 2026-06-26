// tests/retrieval/retrieval.test.ts
// tests for semantic retrieval indexing

import { strict as assert } from 'node:assert'
import { mkdir, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { chunkText } from '../../src/retrieval/chunker.js'
import { collectIndexableFiles } from '../../src/retrieval/files.js'
import { ProjectIndexer } from '../../src/retrieval/indexer.js'
import { SqliteIndexStore } from '../../src/retrieval/sqlite-store.js'
import {
  CHUNKER_VERSION,
  type Embedder,
  type IndexedFile,
} from '../../src/retrieval/types.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { keywordVector } from '../helpers/embed.js'
import { HAS_GIT, initTestRepo } from '../helpers/git.js'

const { tempDir } = makeTempDirPool()

class KeywordEmbedder implements Embedder
{
  model = 'test-embed'
  embeddedTexts: string[] = []

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

  const store = new SqliteIndexStore(join(dir, 'index.sqlite'))
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
  const storeA = new SqliteIndexStore(dbPath)
  const storeB = new SqliteIndexStore(dbPath)
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
