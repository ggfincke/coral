// tests/config.test.ts
// tests for configurable tool permissions

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  resolvePermissions,
  getToolPolicy,
  type ToolPermissions,
} from '../src/config/permissions.js'
import { loadProjectConfig } from '../src/config/project-config.js'
import { loadPrefs } from '../src/config/prefs.js'

const tempDirs: string[] = []
const originalCoralHome = process.env.CORAL_HOME

after(async () =>
{
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

test('resolvePermissions returns sensible defaults when no config files exist', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-config-'))
  tempDirs.push(dir)

  const perms = resolvePermissions(dir)

  assert.equal(perms.read_file, 'always_allow')
  assert.equal(perms.grep, 'always_allow')
  assert.equal(perms.glob, 'always_allow')
  assert.equal(perms.list_files, 'always_allow')
  assert.equal(perms.git_status, 'always_allow')
  assert.equal(perms.git_diff, 'always_allow')
  assert.equal(perms.git_log, 'always_allow')
  assert.equal(perms.search_code, 'always_allow')
  assert.equal(perms.write_file, 'require_approval')
  assert.equal(perms.edit_file, 'require_approval')
  assert.equal(perms.bash, 'require_approval')
})

test('getToolPolicy returns require_approval for unknown tools', async () =>
{
  const perms: ToolPermissions = {}
  assert.equal(getToolPolicy(perms, 'nonexistent_tool'), 'require_approval')
})

test('project-level .coral.json overrides defaults', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-config-'))
  tempDirs.push(dir)

  const config = {
    permissions: {
      bash: 'always_allow',
      read_file: 'require_approval',
    },
  }
  await writeFile(join(dir, '.coral.json'), JSON.stringify(config), 'utf-8')

  const perms = resolvePermissions(dir)

  assert.equal(perms.bash, 'always_allow')
  assert.equal(perms.read_file, 'require_approval')
  // non-overridden defaults preserved
  assert.equal(perms.write_file, 'require_approval')
  assert.equal(perms.grep, 'always_allow')
})

test('always_deny policy is respected', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-config-'))
  tempDirs.push(dir)

  const config = { permissions: { bash: 'always_deny' } }
  await writeFile(join(dir, '.coral.json'), JSON.stringify(config), 'utf-8')

  const perms = resolvePermissions(dir)

  assert.equal(getToolPolicy(perms, 'bash'), 'always_deny')
})

test('invalid permission values are stripped, valid siblings kept', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-config-'))
  tempDirs.push(dir)

  const config = {
    permissions: {
      bash: 'nonsense',
      read_file: 42,
      write_file: 'always_deny',
    },
  }
  await writeFile(join(dir, '.coral.json'), JSON.stringify(config), 'utf-8')

  const perms = resolvePermissions(dir)

  // invalid values fall back to defaults
  assert.equal(perms.bash, 'require_approval')
  assert.equal(perms.read_file, 'always_allow')
  // valid sibling override is still applied
  assert.equal(perms.write_file, 'always_deny')
})

test('corrupt .coral.json is handled gracefully', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-config-'))
  tempDirs.push(dir)

  await writeFile(join(dir, '.coral.json'), 'this is not json{{{', 'utf-8')

  const perms = resolvePermissions(dir)

  // falls back to defaults
  assert.equal(perms.read_file, 'always_allow')
  assert.equal(perms.bash, 'require_approval')
})

test('loadProjectConfig owns non-permission project config sections', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-config-'))
  tempDirs.push(dir)

  const config = {
    retrieval: { embeddingModel: 'mxbai-embed-large' },
    context: { maxNumCtx: 32_768 },
    verify: { enabled: false },
  }
  await writeFile(join(dir, '.coral.json'), JSON.stringify(config), 'utf-8')

  const loaded = loadProjectConfig(dir)

  assert.deepEqual(loaded.retrieval, config.retrieval)
  assert.deepEqual(loaded.context, config.context)
  assert.deepEqual(loaded.verify, config.verify)
})

test('loadProjectConfig ignores non-object JSON config files', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-config-'))
  tempDirs.push(dir)

  await writeFile(join(dir, '.coral.json'), '[]', 'utf-8')

  assert.deepEqual(loadProjectConfig(dir), {})
})

test('loadPrefs ignores array-shaped prefs files', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-prefs-'))
  tempDirs.push(dir)
  process.env.CORAL_HOME = dir

  await writeFile(join(dir, 'prefs.json'), '[]', 'utf-8')

  assert.deepEqual(loadPrefs(), {})
})
