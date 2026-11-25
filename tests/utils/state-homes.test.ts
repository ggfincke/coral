// tests/utils/state-homes.test.ts
// home-dir overrides for CORAL_HOME & AGENTS_HOME never resolve against the launch dir

import { strict as assert } from 'node:assert'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { agentsHomePath } from '../../src/utils/agents-home.js'
import { coralHomePath } from '../../src/utils/coral-home.js'

const original = {
  CORAL_HOME: process.env.CORAL_HOME,
  AGENTS_HOME: process.env.AGENTS_HOME,
}

afterEach(() =>
{
  for (const [name, value] of Object.entries(original))
  {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const HOMES = [
  ['CORAL_HOME', coralHomePath],
  ['AGENTS_HOME', agentsHomePath],
] as const

test('a relative home override resolves under the home dir, not cwd', () =>
{
  for (const [name, resolvePath] of HOMES)
  {
    process.env[name] = '.state'
    assert.equal(resolvePath('x'), join(homedir(), '.state', 'x'))
    assert.equal(resolvePath().startsWith(process.cwd()), false)
  }
})

test('an absolute home override is honored', () =>
{
  for (const [name, resolvePath] of HOMES)
  {
    process.env[name] = '/srv/state'
    assert.equal(resolvePath('x'), join('/srv/state', 'x'))
  }
})
