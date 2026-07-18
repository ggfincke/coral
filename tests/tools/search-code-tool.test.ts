// tests/tools/search-code-tool.test.ts
// tests for search_code tool integration

import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  createSearchCodeTool,
  searchCodeTool,
} from '../../src/tools/search-code.js'
import { createEmbeddingSpace } from '../../src/retrieval/embedding-space.js'
import { DEFAULT_EMBEDDING_MODEL } from '../../src/retrieval/types.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { keywordVector } from '../helpers/embed.js'
import { parseFetchJsonBody, withFetch } from '../helpers/fetch.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()
const EMBEDDING_DIGEST = 'a'.repeat(64)

function tagsResponse(digest = EMBEDDING_DIGEST): Response
{
  return new Response(
    JSON.stringify({
      models: [
        {
          name: `${DEFAULT_EMBEDDING_MODEL}:latest`,
          model: `${DEFAULT_EMBEDDING_MODEL}:latest`,
          size: 1,
          modified_at: '',
          digest,
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

after(async () =>
{
  restoreCoralHome()
  await cleanup()
})

test('search_code indexes the project lazily and returns ranked snippets', async () =>
{
  const dir = await tempDir('coral-search-tool-')
  const home = await tempDir('coral-search-home-')
  process.env.CORAL_HOME = home

  await writeFile(
    join(dir, 'session.ts'),
    'export function restoreSession() {\n  return "auth login";\n}\n',
    'utf-8'
  )
  await writeFile(
    join(dir, 'theme.ts'),
    'export function setTheme() {\n  return "colors";\n}\n',
    'utf-8'
  )

  const requests: { url: string; body: { input: string[]; model: string } }[] =
    []

  await withFetch(
    (input, init) =>
    {
      if (String(input).endsWith('/api/tags')) return tagsResponse()

      const body = parseFetchJsonBody<{
        input: string[]
        model: string
      }>(init)
      requests.push({ url: String(input), body })

      return new Response(
        JSON.stringify({ embeddings: body.input.map(keywordVector) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    },
    async () =>
    {
      const result = await searchCodeTool.execute(
        {
          query: 'where is auth session restored?',
          topK: 1,
        },
        {
          cwd: dir,
          ollamaHost: 'http://ollama.test',
        }
      )

      assert.equal(result.error, undefined)
      assert.match(result.output, /session\.ts:1-3/)
      assert.match(result.output, /restoreSession/)
      assert.ok(
        requests.every(
          (request) => request.url === 'http://ollama.test/api/embed'
        )
      )
      assert.ok(
        requests.every(
          (request) =>
            request.body.model === `${DEFAULT_EMBEDDING_MODEL}:latest`
        )
      )
    }
  )
})

test('search_code uses the execution context host per invocation', async () =>
{
  const dir = await tempDir('coral-search-context-')
  const home = await tempDir('coral-search-context-home-')
  process.env.CORAL_HOME = home

  await writeFile(
    join(dir, 'session.ts'),
    'export function restoreSession() {\n  return "auth login";\n}\n',
    'utf-8'
  )

  const urls: string[] = []
  await withFetch(
    (input, init) =>
    {
      urls.push(String(input))
      if (String(input).endsWith('/api/tags')) return tagsResponse()

      const body = parseFetchJsonBody<{ input: string[] }>(init)

      return new Response(
        JSON.stringify({ embeddings: body.input.map(keywordVector) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    },
    async () =>
    {
      const first = await searchCodeTool.execute(
        { query: 'auth session', topK: 1 },
        { cwd: dir, ollamaHost: 'http://ollama-a.test' }
      )
      const second = await searchCodeTool.execute(
        { query: 'auth session', topK: 1 },
        { cwd: dir, ollamaHost: 'http://ollama-b.test' }
      )

      assert.equal(first.error, undefined)
      assert.equal(second.error, undefined)
      assert.ok(urls.includes('http://ollama-a.test/api/embed'))
      assert.ok(urls.includes('http://ollama-b.test/api/embed'))
    }
  )
})

test('search_code appends ollama pull hint for missing embedding models', async () =>
{
  const dir = await tempDir('coral-search-missing-model-')
  const home = await tempDir('coral-search-missing-model-home-')
  process.env.CORAL_HOME = home

  await writeFile(
    join(dir, 'session.ts'),
    'export function restoreSession() {\n  return "auth login";\n}\n',
    'utf-8'
  )

  const originalModel = process.env.CORAL_EMBEDDING_MODEL
  process.env.CORAL_EMBEDDING_MODEL = 'custom-embed'
  try
  {
    await withFetch(
      () => new Response('model not found', { status: 404 }),
      async () =>
      {
        const result = await searchCodeTool.execute(
          { query: 'auth session', topK: 1 },
          { cwd: dir, ollamaHost: 'http://ollama.test' }
        )

        assert.equal(result.output, '')
        assert.match(result.error ?? '', /search_code failed/)
        assert.match(
          result.error ?? '',
          /while using embedding model custom-embed/
        )
        assert.match(
          result.error ?? '',
          /Ollama API error: 404 model not found/
        )
        assert.match(result.error ?? '', /ollama pull custom-embed/)
        assert.doesNotMatch(result.error ?? '', /ollama pull nomic-embed-text/)
      }
    )
  }
  finally
  {
    if (originalModel === undefined)
    {
      delete process.env.CORAL_EMBEDDING_MODEL
    }
    else
    {
      process.env.CORAL_EMBEDDING_MODEL = originalModel
    }
  }
})

test('search_code does not suggest pulling for invalid artifact identity', async () =>
{
  const dir = await tempDir('coral-search-invalid-identity-')
  await withFetch(
    () => tagsResponse('not-a-digest'),
    async () =>
    {
      const result = await searchCodeTool.execute(
        { query: 'auth session' },
        { cwd: dir, ollamaHost: 'http://ollama.test' }
      )

      assert.match(result.error ?? '', /no valid immutable SHA-256 digest/)
      assert.doesNotMatch(result.error ?? '', /ollama pull/)
    }
  )
})

test('search_code does not suggest pulling for ambiguous model identity', async () =>
{
  const dir = await tempDir('coral-search-ambiguous-identity-')
  await withFetch(
    () =>
      new Response(
        JSON.stringify({
          models: [
            {
              name: `${DEFAULT_EMBEDDING_MODEL}:latest`,
              digest: EMBEDDING_DIGEST,
            },
            {
              name: `${DEFAULT_EMBEDDING_MODEL.toUpperCase()}:latest`,
              digest: 'b'.repeat(64),
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } }
      ),
    async () =>
    {
      const result = await searchCodeTool.execute(
        { query: 'auth session' },
        { cwd: dir, ollamaHost: 'http://ollama.test' }
      )

      assert.match(result.error ?? '', /matches multiple/)
      assert.doesNotMatch(result.error ?? '', /ollama pull/)
    }
  )
})

test('search_code reports store construction failures as tool errors', async () =>
{
  const dir = await tempDir('coral-search-store-failure-')
  const tool = createSearchCodeTool({
    resolveSpace: async (_client, host) =>
      createEmbeddingSpace(host, {
        model: `${DEFAULT_EMBEDDING_MODEL}:latest`,
        digest: EMBEDDING_DIGEST,
      }),
    createStore()
    {
      throw new Error('native sqlite unavailable')
    },
  })

  const result = await tool.execute(
    { query: 'auth session' },
    { cwd: dir, ollamaHost: 'http://ollama.test' }
  )

  assert.equal(result.output, '')
  assert.match(result.error ?? '', /search_code failed/)
  assert.match(result.error ?? '', /native sqlite unavailable/)
  assert.doesNotMatch(result.error ?? '', /ollama pull/)
})

test('search_code fails before persistence when the model artifact changes', async () =>
{
  const dir = await tempDir('coral-search-identity-change-')
  const home = await tempDir('coral-search-identity-change-home-')
  process.env.CORAL_HOME = home
  await writeFile(join(dir, 'session.ts'), 'export const session = true\n')

  let tagReads = 0
  await withFetch(
    (input, init) =>
    {
      if (String(input).endsWith('/api/tags'))
      {
        tagReads += 1
        return tagsResponse(tagReads >= 3 ? 'b'.repeat(64) : EMBEDDING_DIGEST)
      }

      const body = parseFetchJsonBody<{ input: string[] }>(init)
      return new Response(
        JSON.stringify({ embeddings: body.input.map(keywordVector) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    },
    async () =>
    {
      const result = await searchCodeTool.execute(
        { query: 'session' },
        { cwd: dir, ollamaHost: 'http://ollama.test' }
      )

      assert.equal(result.output, '')
      assert.match(result.error ?? '', /changed artifact identity/)
      assert.doesNotMatch(result.error ?? '', /ollama pull/)
    }
  )
})
