// tests/agent/context.test.ts
// tests for startup project context injection

import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  gatherProjectContext,
  projectContextBudgetForWindow,
} from '../../src/agent/context.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

const tempProject = () => tempDir('coral-ctx-')

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

test('projectContextBudgetForWindow scales and clamps the injected budget', () =>
{
  assert.equal(projectContextBudgetForWindow(0), 16_384)
  assert.equal(projectContextBudgetForWindow(8_192), 4_096)
  assert.equal(projectContextBudgetForWindow(32_768), 16_384)
  assert.equal(projectContextBudgetForWindow(262_144), 32_768)
})

test('gatherProjectContext respects an explicit total budget', async () =>
{
  const dir = await tempProject()
  await writeFile(join(dir, '.coral.md'), 'x'.repeat(600))

  const ctx = gatherProjectContext(dir, { maxTotalChars: 300 })

  assert.match(ctx, /truncated to fit budget/)
  assert.ok(ctx.length <= 300)
})
