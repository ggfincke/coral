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

const tempDirs: string[] = []

after(async () =>
{
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
