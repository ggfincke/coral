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
import { resolveRetrievalConfig } from '../../src/config/retrieval.js'
import { resolveVerifyConfig } from '../../src/config/verify.js'
import { loadPrefs, savePrefs } from '../../src/config/prefs.js'
import { DEFAULT_EMBEDDING_MODEL } from '../../src/retrieval/types.js'
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

test('getToolPolicy fails closed for unknown and prototype tool names', async () =>
{
  const perms: ToolPermissions = {}
  for (const name of [
    'nonexistent_tool',
    'toString',
    'constructor',
    '__proto__',
    'hasOwnProperty',
  ])
  {
    assert.equal(getToolPolicy(perms, name), 'require_approval', name)
  }
})

test('prototype-named permission overrides preserve exact tighten-only policy', async () =>
{
  const userHome = await tempDir('coral-user-config-')
  const allowedProject = await tempDir('coral-config-')
  const tightenedProject = await tempDir('coral-config-')
  const loosenedProject = await tempDir('coral-config-')
  const originalHome = process.env.HOME
  await writeFile(
    join(userHome, '.coral.json'),
    '{"permissions":{"__proto__":"always_allow","toString":"always_allow"}}',
    'utf-8'
  )
  await writeFile(
    join(tightenedProject, '.coral.json'),
    '{"permissions":{"__proto__":"require_approval","toString":"always_deny"}}',
    'utf-8'
  )
  await writeFile(
    join(loosenedProject, '.coral.json'),
    '{"permissions":{"constructor":"always_allow"}}',
    'utf-8'
  )

  process.env.HOME = userHome
  try
  {
    const allowed = resolvePermissions(allowedProject)
    assert.equal(Object.getPrototypeOf(allowed), null)
    assert.equal(getToolPolicy(allowed, '__proto__'), 'always_allow')
    assert.equal(getToolPolicy(allowed, 'toString'), 'always_allow')

    const tightened = resolvePermissions(tightenedProject)
    assert.equal(getToolPolicy(tightened, '__proto__'), 'require_approval')
    assert.equal(getToolPolicy(tightened, 'toString'), 'always_deny')

    assert.equal(
      getToolPolicy(resolvePermissions(loosenedProject), 'constructor'),
      'require_approval'
    )
  }
  finally
  {
    if (originalHome === undefined)
    {
      delete process.env.HOME
    }
    else
    {
      process.env.HOME = originalHome
    }
  }
})

test('exact user dynamic-tool allow remains project tighten-only', async () =>
{
  const userHome = await tempDir('coral-user-config-')
  const allowedProject = await tempDir('coral-config-')
  const tightenedProject = await tempDir('coral-config-')
  const originalHome = process.env.HOME
  await writeFile(
    join(userHome, '.coral.json'),
    JSON.stringify({
      permissions: { mcp__fixture__echo: 'always_allow' },
    }),
    'utf-8'
  )
  await writeFile(
    join(tightenedProject, '.coral.json'),
    JSON.stringify({
      permissions: { mcp__fixture__echo: 'require_approval' },
    }),
    'utf-8'
  )

  process.env.HOME = userHome
  try
  {
    assert.equal(
      getToolPolicy(resolvePermissions(allowedProject), 'mcp__fixture__echo'),
      'always_allow'
    )
    assert.equal(
      getToolPolicy(resolvePermissions(tightenedProject), 'mcp__fixture__echo'),
      'require_approval'
    )
  }
  finally
  {
    if (originalHome === undefined)
    {
      delete process.env.HOME
    }
    else
    {
      process.env.HOME = originalHome
    }
  }
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

test('loadProjectConfig preserves raw project config sections', async () =>
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

test('retrieval and verify resolvers validate raw values and preserve precedence', async () =>
{
  const malformedDir = await tempDir('coral-config-')
  const validDir = await tempDir('coral-config-')
  await writeFile(
    join(malformedDir, '.coral.json'),
    JSON.stringify({
      permissions: 'always_allow',
      retrieval: [],
      verify: { enabled: 'false' },
    }),
    'utf-8'
  )
  await writeFile(
    join(validDir, '.coral.json'),
    JSON.stringify({
      retrieval: { embeddingModel: 'project-embed' },
      verify: { enabled: true },
    }),
    'utf-8'
  )

  const original = process.env.CORAL_EMBEDDING_MODEL
  delete process.env.CORAL_EMBEDDING_MODEL
  try
  {
    assert.equal(resolvePermissions(malformedDir).bash, 'require_approval')
    assert.equal(
      resolveRetrievalConfig(malformedDir).embeddingModel,
      DEFAULT_EMBEDDING_MODEL
    )
    assert.deepEqual(resolveVerifyConfig(malformedDir), { enabled: false })
    assert.equal(
      resolveRetrievalConfig(validDir).embeddingModel,
      'project-embed'
    )
    assert.deepEqual(resolveVerifyConfig(validDir), { enabled: true })

    process.env.CORAL_EMBEDDING_MODEL = 'env-embed'
    assert.equal(resolveRetrievalConfig(validDir).embeddingModel, 'env-embed')
  }
  finally
  {
    if (original === undefined)
    {
      delete process.env.CORAL_EMBEDDING_MODEL
    }
    else
    {
      process.env.CORAL_EMBEDDING_MODEL = original
    }
  }
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
