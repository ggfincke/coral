// tests/search-code-tool.test.ts
// tests for search_code tool integration

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setCwd } from '../src/cwd.js'
import { setOllamaHost } from '../src/ollama/host.js'
import { searchCodeTool } from '../src/tools/search-code.js'

const tempDirs: string[] = []
const originalCwd = process.cwd()
const originalFetch = globalThis.fetch
const originalCoralHome = process.env.CORAL_HOME

after(async () =>
{
  setCwd(originalCwd)
  setOllamaHost(undefined)
  globalThis.fetch = originalFetch

  if (originalCoralHome === undefined)
  {
    delete process.env.CORAL_HOME
  }
  else
  {
    process.env.CORAL_HOME = originalCoralHome
  }

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

function vectorFor(text: string): number[]
{
  return /auth|login|session/i.test(text) ? [1, 0] : [0, 1]
}

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

  globalThis.fetch = (async (input, init) =>
  {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      input: string[]
      model: string
    }
    requests.push({ url: String(input), body })

    return new Response(
      JSON.stringify({ embeddings: body.input.map(vectorFor) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }) as typeof fetch

  setCwd(dir)
  setOllamaHost('http://ollama.test')

  const result = await searchCodeTool.execute({
    query: 'where is auth session restored?',
    topK: 1,
  })

  assert.equal(result.error, undefined)
  assert.match(result.output, /session\.ts:1-3/)
  assert.match(result.output, /restoreSession/)
  assert.ok(
    requests.every((request) => request.url === 'http://ollama.test/api/embed')
  )
  assert.ok(
    requests.every((request) => request.body.model === 'nomic-embed-text')
  )
})

test('search_code validates query input before indexing', async () =>
{
  const result = await searchCodeTool.execute({ query: '   ' })

  assert.equal(result.output, '')
  assert.match(result.error ?? '', /non-empty query/)
})
