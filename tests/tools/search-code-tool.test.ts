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
import { DEFAULT_EMBEDDING_MODEL } from '../../src/retrieval/types.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { keywordVector } from '../helpers/embed.js'
import { parseFetchJsonBody, withFetch } from '../helpers/fetch.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()

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
          (request) => request.body.model === DEFAULT_EMBEDDING_MODEL
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
      const body = parseFetchJsonBody<{ input: string[] }>(init)
      urls.push(String(input))

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
      assert.match(result.error ?? '', /Ollama API error: 404 model not found/)
      assert.match(result.error ?? '', /ollama pull nomic-embed-text/)
    }
  )
})

test('search_code reports store construction failures as tool errors', async () =>
{
  const dir = await tempDir('coral-search-store-failure-')
  const tool = createSearchCodeTool({
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
