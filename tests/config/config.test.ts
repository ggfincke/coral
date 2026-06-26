// tests/config/config.test.ts
// tests for configurable tool permissions

import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  resolvePermissions,
  getToolPolicy,
  type ToolPermissions,
} from '../../src/config/permissions.js'
import { loadProjectConfig } from '../../src/config/project-config.js'
import { loadPrefs, savePrefs } from '../../src/config/prefs.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { captureCoralHome } from '../helpers/coral-home.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()

after(async () =>
{
  restoreCoralHome()
  await cleanup()
})

test('resolvePermissions returns sensible defaults when no config files exist', async () =>
{
  const dir = await tempDir('coral-config-')

  const perms = resolvePermissions(dir)

  assert.equal(perms.read_file, 'always_allow')
  assert.equal(perms.grep, 'always_allow')
  assert.equal(perms.glob, 'always_allow')
  assert.equal(perms.list_files, 'always_allow')
  assert.equal(perms.git_status, 'always_allow')
  assert.equal(perms.git_diff, 'always_allow')
  assert.equal(perms.git_log, 'always_allow')
  assert.equal(perms.search_code, 'always_allow')
  assert.equal(perms.git_switch, 'require_approval')
  assert.equal(perms.write_file, 'require_approval')
  assert.equal(perms.edit_file, 'require_approval')
  assert.equal(perms.bash, 'require_approval')
})

test('getToolPolicy returns require_approval for unknown tools', async () =>
{
  const perms: ToolPermissions = {}
  assert.equal(getToolPolicy(perms, 'nonexistent_tool'), 'require_approval')
})

test('project-level .coral.json can tighten but not weaken permissions', async () =>
{
  const dir = await tempDir('coral-config-')

  const config = {
    permissions: {
      bash: 'always_allow',
      read_file: 'require_approval',
    },
  }
  await writeFile(join(dir, '.coral.json'), JSON.stringify(config), 'utf-8')

  const perms = resolvePermissions(dir)

  assert.equal(perms.bash, 'require_approval')
  assert.equal(perms.read_file, 'require_approval')
  // non-overridden defaults preserved
  assert.equal(perms.write_file, 'require_approval')
  assert.equal(perms.grep, 'always_allow')
})

test('always_deny policy is respected', async () =>
{
  const dir = await tempDir('coral-config-')

  const config = { permissions: { bash: 'always_deny' } }
  await writeFile(join(dir, '.coral.json'), JSON.stringify(config), 'utf-8')

  const perms = resolvePermissions(dir)

  assert.equal(getToolPolicy(perms, 'bash'), 'always_deny')
})

test('invalid permission values are stripped, valid siblings kept', async () =>
{
  const dir = await tempDir('coral-config-')

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
  const dir = await tempDir('coral-config-')

  await writeFile(join(dir, '.coral.json'), 'this is not json{{{', 'utf-8')

  const perms = resolvePermissions(dir)

  // falls back to defaults
  assert.equal(perms.read_file, 'always_allow')
  assert.equal(perms.bash, 'require_approval')
})

test('loadProjectConfig owns non-permission project config sections', async () =>
{
  const dir = await tempDir('coral-config-')

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
  const dir = await tempDir('coral-config-')

  await writeFile(join(dir, '.coral.json'), '[]', 'utf-8')

  assert.deepEqual(loadProjectConfig(dir), {})
})

test('loadPrefs ignores array-shaped prefs files', async () =>
{
  const dir = await tempDir('coral-prefs-')
  process.env.CORAL_HOME = dir

  await writeFile(join(dir, 'prefs.json'), '[]', 'utf-8')

  assert.deepEqual(loadPrefs(), {})
})

test('savePrefs merges and round-trips through disk', async () =>
{
  const dir = await tempDir('coral-prefs-')
  process.env.CORAL_HOME = dir

  assert.deepEqual(loadPrefs(), {})
  const saved = savePrefs({ theme: 'dracula' })
  assert.deepEqual(saved, { theme: 'dracula' })
  assert.deepEqual(loadPrefs(), { theme: 'dracula' })

  const merged = savePrefs({ theme: 'nord' })
  assert.deepEqual(merged, { theme: 'nord' })
  assert.deepEqual(loadPrefs(), { theme: 'nord' })
})
