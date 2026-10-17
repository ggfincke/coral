// tests/config/tool-grants.test.ts
// tests for persisted per-workspace tool grants

import { strict as assert } from 'node:assert'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import {
  fingerprintToolGrant,
  isToolGrantTrusted,
  listToolGrants,
  revokeToolGrant,
  trustToolGrant,
  workspaceToolGrants,
} from '../../src/config/tool-grants.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDirSync, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()

beforeEach(() =>
{
  process.env.CORAL_HOME = tempDirSync('coral-grants-home-')
})

after(async () =>
{
  restoreCoralHome()
  await cleanup()
})

test('grants are keyed to tool and workspace, and fail closed on anything else', () =>
{
  const workspace = '/work/alpha'
  const bash = { toolName: 'bash', workspace }

  assert.equal(isToolGrantTrusted(bash), false)
  trustToolGrant(bash)
  assert.equal(isToolGrantTrusted(bash), true)

  // the fingerprint is stable and distinct per tool and per workspace
  assert.equal(fingerprintToolGrant(bash), fingerprintToolGrant({ ...bash }))
  assert.equal(
    isToolGrantTrusted({ toolName: 'bash', workspace: '/work/beta' }),
    false
  )
  assert.equal(isToolGrantTrusted({ toolName: 'write_file', workspace }), false)

  // a sidecar whose body disagrees with its name reads as no grant
  const dir = join(process.env.CORAL_HOME!, 'tool-grants.d')
  const forged = fingerprintToolGrant({ toolName: 'git_push', workspace })
  writeFileSync(
    join(dir, `${forged}.json`),
    JSON.stringify({
      version: 1,
      toolName: 'git_push',
      workspace: '/work/beta',
      fingerprint: forged,
      approvedAt: 'now',
    })
  )
  assert.equal(isToolGrantTrusted({ toolName: 'git_push', workspace }), false)
  writeFileSync(join(dir, 'garbage.json'), '{not json')
  writeFileSync(
    join(
      dir,
      `${fingerprintToolGrant({ toolName: 'edit_file', workspace })}.json`
    ),
    JSON.stringify({ version: 2, toolName: 'edit_file', workspace })
  )
  assert.equal(isToolGrantTrusted({ toolName: 'edit_file', workspace }), false)

  // listing returns only valid grants for the asked workspace
  trustToolGrant({ toolName: 'write_file', workspace: '/work/beta' })
  assert.deepEqual(
    listToolGrants(workspace).map((record) => record.toolName),
    ['bash']
  )
  assert.deepEqual(
    listToolGrants('/work/beta').map((record) => record.toolName),
    ['write_file']
  )

  // revoke reports whether a grant existed and removes only that file
  assert.equal(revokeToolGrant(bash), true)
  assert.equal(revokeToolGrant(bash), false)
  assert.equal(isToolGrantTrusted(bash), false)
  assert.equal(listToolGrants('/work/beta').length, 1)
})

test('only trusted built-in tools can be persisted', () =>
{
  const workspace = '/work/alpha'
  assert.throws(() =>
    trustToolGrant({ toolName: 'mcp__fixture__echo', workspace })
  )
  assert.throws(() => trustToolGrant({ toolName: 'nonexistent', workspace }))
  assert.equal(
    isToolGrantTrusted({ toolName: 'mcp__fixture__echo', workspace }),
    false
  )

  // a hand-planted MCP sidecar is ignored even when internally consistent
  const dir = join(process.env.CORAL_HOME!, 'tool-grants.d')
  mkdirSync(dir, { recursive: true })
  const mcp = { toolName: 'mcp__fixture__echo', workspace }
  const fingerprint = fingerprintToolGrant(mcp)
  writeFileSync(
    join(dir, `${fingerprint}.json`),
    JSON.stringify({ version: 1, ...mcp, fingerprint, approvedAt: 'now' })
  )
  assert.equal(isToolGrantTrusted(mcp), false)
  assert.deepEqual(listToolGrants(workspace), [])
  assert.equal(readdirSync(dir).length, 1)
})

test('workspace binding canonicalizes the cwd once', () =>
{
  const cwd = tempDirSync('coral-grants-ws-')
  const grants = workspaceToolGrants(join(cwd, '.', 'nested', '..'))
  assert.equal(grants.workspace, workspaceToolGrants(cwd).workspace)

  grants.trust('bash')
  assert.equal(grants.isTrusted('bash'), true)
  assert.equal(workspaceToolGrants(cwd).isTrusted('bash'), true)
  assert.deepEqual(
    grants.list().map((record) => record.toolName),
    ['bash']
  )
  assert.equal(grants.revoke('bash'), true)
  assert.equal(grants.isTrusted('bash'), false)
})
