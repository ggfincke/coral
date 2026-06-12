// tests/context.test.ts
// tests for startup project context injection

import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { gatherProjectContext } from '../src/agent/context.js'

const tempDirs: string[] = []

after(async () =>
{
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

async function tempProject(): Promise<string>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-ctx-'))
  tempDirs.push(dir)
  return dir
}

test('gatherProjectContext loads project instructions and key metadata', async () =>
{
  const dir = await tempProject()
  await writeFile(join(dir, '.coral.md'), '# Project Instructions\nDo this.\n')
  await writeFile(join(dir, 'README.md'), '# My App\n')
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }))

  const ctx = gatherProjectContext(dir)

  assert.match(ctx, /Project Instructions/)
  assert.match(ctx, /Detected project type: Node\.js\/JavaScript/)
  assert.match(ctx, /package\.json/)
  assert.match(ctx, /my-app/)
})

test('gatherProjectContext includes a compact directory tree', async () =>
{
  const dir = await tempProject()
  await writeFile(join(dir, 'README.md'), '# Test\n')
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src', 'index.ts'), '// entry\n')

  const ctx = gatherProjectContext(dir)

  assert.match(ctx, /Directory structure/)
  assert.match(ctx, /src\//)
  assert.match(ctx, /index\.ts/)
})

test('gatherProjectContext truncates oversized context files', async () =>
{
  const dir = await tempProject()
  const bigContent = 'x'.repeat(10_000)
  await writeFile(join(dir, 'README.md'), bigContent)

  const ctx = gatherProjectContext(dir)

  assert.match(ctx, /truncated/)
  assert.ok(ctx.length < bigContent.length)
})
