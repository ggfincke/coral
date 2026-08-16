// tests/retrieval/build.test.ts
// createEmbedder injection and mlx-without-worker failure

import { strict as assert } from 'node:assert'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildIndexer } from '../../src/retrieval/build.js'
import { createEmbeddingSpace } from '../../src/retrieval/embedding-space.js'
import { SqliteIndexStore } from '../../src/retrieval/sqlite-store.js'
import type { Embedder, EmbeddingSpace } from '../../src/retrieval/types.js'
import { mlxEmbeddingEndpointIdentity } from '../../src/tools/search-code-deps.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

class RecordingEmbedder implements Embedder
{
  calls = 0

  constructor(public space: EmbeddingSpace)
  {}

  async embed(texts: string[]): Promise<number[][]>
  {
    this.calls += 1
    return texts.map(() => [1, 0])
  }
}

test('buildIndexer uses an injected createEmbedder', async () =>
{
  const cwd = await tempDir('coral-build-inject-')
  const home = await tempDir('coral-build-inject-home-')
  const previousHome = process.env.CORAL_HOME
  process.env.CORAL_HOME = home
  await writeFile(join(cwd, 'feature.ts'), 'export const feature = true\n')
  const space = createEmbeddingSpace('http://ollama.test', {
    model: 'nomic-embed-text',
    digest: 'a'.repeat(64),
  })
  const embedder = new RecordingEmbedder(space)
  let lookupModel = ''
  const built = await buildIndexer(cwd, 'http://ollama.test', undefined, {
    resolveSpace: async (_client, _host, model) =>
    {
      lookupModel = model
      return space
    },
    createStore: (next) => new SqliteIndexStore(next, join(home, 'idx.sqlite')),
    createEmbedder: () => embedder,
  })
  try
  {
    await built.indexer.search('feature', 1)
    assert.ok(embedder.calls > 0)
    assert.equal(built.embeddingSpace.id, space.id)
    assert.equal(lookupModel, 'ollama:nomic-embed-text')
    assert.equal(built.embeddingModel, 'ollama:nomic-embed-text')
  }
  finally
  {
    built.store.close?.()
    if (previousHome === undefined) delete process.env.CORAL_HOME
    else process.env.CORAL_HOME = previousHome
  }
})

test('mlx endpoint identity resolves aliases to the worker checkpoint root', async () =>
{
  const parent = await tempDir('coral-build-mlx-identity-')
  const real = join(parent, 'real-models')
  const alias = join(parent, 'models-link')
  await mkdir(real)
  await symlink(real, alias, 'dir')
  const original = process.env.CORAL_MLX_MODELS_DIR
  process.env.CORAL_MLX_MODELS_DIR = alias
  try
  {
    assert.equal(mlxEmbeddingEndpointIdentity(), await realpath(real))
  }
  finally
  {
    if (original === undefined) delete process.env.CORAL_MLX_MODELS_DIR
    else process.env.CORAL_MLX_MODELS_DIR = original
  }
})

test('buildIndexer refuses mlx embeddings without an injected embedder', async () =>
{
  const cwd = await tempDir('coral-build-mlx-')
  const original = process.env.CORAL_EMBEDDING_MODEL
  process.env.CORAL_EMBEDDING_MODEL = 'mlx:Qwen3-Embedding-0.6B'
  try
  {
    await assert.rejects(
      () => buildIndexer(cwd, 'http://ollama.test'),
      /createEmbedder|Python worker/
    )
  }
  finally
  {
    if (original === undefined) delete process.env.CORAL_EMBEDDING_MODEL
    else process.env.CORAL_EMBEDDING_MODEL = original
  }
})
