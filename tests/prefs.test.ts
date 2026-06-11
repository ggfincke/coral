// tests/prefs.test.ts
// tests for user prefs persistence

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { loadPrefs, savePrefs } from '../src/config/prefs.js'

const originalCoralHome = process.env.CORAL_HOME
const tempDirs: string[] = []

async function useTempCoralHome(): Promise<string>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-prefs-'))
  tempDirs.push(dir)
  process.env.CORAL_HOME = dir
  return dir
}

beforeEach(async () =>
{
  await useTempCoralHome()
})

after(async () =>
{
  if (originalCoralHome === undefined) delete process.env.CORAL_HOME
  else process.env.CORAL_HOME = originalCoralHome
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

test('loadPrefs returns empty prefs when no file exists', () =>
{
  assert.deepEqual(loadPrefs(), {})
})

test('savePrefs round-trips through loadPrefs', () =>
{
  savePrefs({ theme: 'deep-sea' })
  assert.deepEqual(loadPrefs(), { theme: 'deep-sea' })
})

test('savePrefs merges patches w/o clobbering other keys', async () =>
{
  const dir = process.env.CORAL_HOME!
  await writeFile(
    join(dir, 'prefs.json'),
    JSON.stringify({ theme: 'kelp-forest', future: 'kept' }),
    'utf-8'
  )

  savePrefs({ theme: 'tide-pool' })

  const prefs = loadPrefs() as Record<string, unknown>
  assert.equal(prefs.theme, 'tide-pool')
  assert.equal(prefs.future, 'kept')
})

test('loadPrefs tolerates corrupt or non-object files', async () =>
{
  const dir = process.env.CORAL_HOME!
  await writeFile(join(dir, 'prefs.json'), 'not json{', 'utf-8')
  assert.deepEqual(loadPrefs(), {})

  await writeFile(join(dir, 'prefs.json'), '"a string"', 'utf-8')
  assert.deepEqual(loadPrefs(), {})
})

test('savePrefs creates the coral home dir when missing', () =>
{
  process.env.CORAL_HOME = join(tempDirs[tempDirs.length - 1]!, 'nested', 'dir')
  savePrefs({ theme: 'adaptive' })
  assert.deepEqual(loadPrefs(), { theme: 'adaptive' })
})
