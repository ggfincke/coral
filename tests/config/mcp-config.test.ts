// tests/config/mcp-config.test.ts
// test MCP launch config & trust boundaries

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseMcpConfig } from '../../src/config/mcp.js'
import { defaultToolPermissions } from '../../src/config/permissions.js'
import { loadProjectConfig } from '../../src/config/project-config.js'
import { McpManager } from '../../src/mcp/manager.js'
import {
  fingerprintMcpLaunch,
  isMcpLaunchTrusted,
  trustMcpLaunch,
  type McpLaunchDescriptor,
} from '../../src/mcp/trust.js'
import { allTools } from '../../src/tools/registry.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()

after(async () =>
{
  restoreCoralHome()
  await cleanup()
})

test('MCP launch config stays user-owned and fingerprint-gated', async () =>
{
  const workspace = await tempDir('coral-mcp-workspace-')
  const coralHome = await tempDir('coral-mcp-home-')
  process.env.CORAL_HOME = coralHome

  await writeFile(
    join(workspace, '.coral.json'),
    JSON.stringify({
      permissions: { mcp__github__get_me: 'always_deny' },
      mcp: {
        servers: {
          malicious: { command: 'node', args: ['server.js'] },
        },
      },
    }),
    'utf-8'
  )

  const projectConfig = loadProjectConfig(workspace)
  assert.equal('mcp' in projectConfig, false)
  assert.deepEqual(projectConfig.permissions, {
    mcp__github__get_me: 'always_deny',
  })

  const resolved = parseMcpConfig({
    servers: {
      github: {
        command: 'docker',
        args: [
          'run',
          '-i',
          '--rm',
          '-e',
          'GITHUB_PERSONAL_ACCESS_TOKEN',
          '-e',
          'GITHUB_READ_ONLY',
          '-e',
          'GITHUB_TOOLS',
          'github-mcp-server',
        ],
        enabledTools: ['get_me', 'get_file_contents', 'pull_request_read'],
        yoloTools: ['get_me', 'get_file_contents'],
        passEnv: [
          'GITHUB_PERSONAL_ACCESS_TOKEN',
          'GITHUB_READ_ONLY',
          'GITHUB_TOOLS',
        ],
      },
    },
  })
  assert.deepEqual(resolved.issues, [])
  assert.equal(resolved.servers.length, 1)
  assert.equal(resolved.servers[0]?.launchCwd, homedir())
  assert.deepEqual(resolved.servers[0]?.yoloTools, [
    'get_me',
    'get_file_contents',
  ])

  const unsafeToolName = parseMcpConfig({
    servers: {
      unsafe: {
        command: 'node',
        enabledTools: ['get_\x1b[31msecret'],
      },
    },
  })
  assert.match(unsafeToolName.issues[0]?.message ?? '', /invalid value/)

  const askOnly = parseMcpConfig({
    servers: {
      ask_only: { command: 'node', enabledTools: ['get_me'] },
    },
  })
  assert.deepEqual(askOnly.servers[0]?.yoloTools, [])

  const unsafeYoloTools = parseMcpConfig({
    servers: {
      duplicate: {
        command: 'node',
        enabledTools: ['get_me'],
        yoloTools: ['get_me', 'get_me'],
      },
      widened: {
        command: 'node',
        enabledTools: ['get_me'],
        yoloTools: ['delete_repository'],
      },
    },
  })
  assert.deepEqual(
    unsafeYoloTools.issues.map((issue) => issue.message),
    [
      'yoloTools contains duplicate values',
      'yoloTools must be a subset of enabledTools',
    ]
  )

  const server = resolved.servers[0]!
  const descriptor: McpLaunchDescriptor = {
    alias: server.alias,
    command: server.command,
    executable: '/usr/local/bin/docker',
    args: server.args,
    launchCwd: server.launchCwd,
    passEnv: server.passEnv,
    enabledTools: server.enabledTools,
    yoloTools: server.yoloTools,
  }

  // an empty yolo subset preserves the exact v0.13 fingerprint payload
  const askOnlyDescriptor = { ...descriptor, yoloTools: [] }
  const legacyPayload = {
    version: 1,
    alias: descriptor.alias,
    command: descriptor.command,
    executable: descriptor.executable,
    args: descriptor.args,
    launchCwd: descriptor.launchCwd,
    passEnv: [...descriptor.passEnv].sort(),
    enabledTools: [...descriptor.enabledTools].sort(),
  }
  const legacyFingerprint = createHash('sha256')
    .update(JSON.stringify(legacyPayload))
    .digest('hex')
  assert.equal(fingerprintMcpLaunch(askOnlyDescriptor), legacyFingerprint)

  assert.equal(isMcpLaunchTrusted(descriptor), false)
  trustMcpLaunch(descriptor)
  assert.equal(isMcpLaunchTrusted(descriptor), true)
  assert.equal(
    isMcpLaunchTrusted({ ...descriptor, args: [...descriptor.args, '--pull'] }),
    false
  )
  assert.equal(
    isMcpLaunchTrusted({ ...descriptor, yoloTools: ['get_me'] }),
    false
  )

  if (process.platform !== 'win32')
  {
    const info = await stat(
      join(coralHome, 'mcp-trust.d', `${descriptor.alias}.json`)
    )
    assert.equal(info.mode & 0o777, 0o600)
  }

  // exact always_deny blocks a fully-denied server before launch approval,
  // executable resolution, or any process spawn
  const deniedConfig = parseMcpConfig({
    servers: {
      denied: {
        command: 'node',
        enabledTools: ['list'],
        yoloTools: ['list'],
      },
    },
  })
  assert.deepEqual(deniedConfig.issues, [])
  const deniedManager = new McpManager({
    config: deniedConfig,
    mode: 'yolo',
    permissions: {
      ...defaultToolPermissions(),
      mcp__denied__list: 'always_deny',
    },
    baseTools: allTools,
    maxDynamicToolTokens: 8_192,
  })
  let approvalRequested = false
  const deniedTools = await deniedManager.initialize({
    async onLaunchApproval()
    {
      approvalRequested = true
      return true
    },
  })
  assert.deepEqual(deniedTools, [])
  assert.equal(approvalRequested, false)
  const deniedStatus = deniedManager.getStatus().servers[0]
  assert.equal(deniedStatus?.state, 'blocked')
  assert.match(deniedStatus?.message ?? '', /denied by permission policy/)
  assert.equal(deniedStatus?.executable, undefined)
  await deniedManager.dispose()
})

test('MCP config reports malformed raw section shapes', () =>
{
  const resolved = parseMcpConfig([])

  assert.deepEqual(resolved.servers, [])
  assert.deepEqual(resolved.issues, [
    { message: 'mcp.servers must be an object' },
  ])
})

test('MCP trust sidecars preserve legacy aliases and fail closed when invalid', async () =>
{
  const coralHome = await tempDir('coral-mcp-home-')
  process.env.CORAL_HOME = coralHome

  const legacy: McpLaunchDescriptor = {
    alias: 'legacy',
    command: 'node',
    executable: '/usr/local/bin/node',
    args: ['legacy.js'],
    launchCwd: homedir(),
    passEnv: [],
    enabledTools: ['echo'],
    yoloTools: [],
  }
  const current: McpLaunchDescriptor = {
    ...legacy,
    alias: 'current',
    args: ['current.js'],
  }
  const dangling: McpLaunchDescriptor = {
    ...legacy,
    alias: 'dangling',
    args: ['dangling.js'],
  }
  await writeFile(
    join(coralHome, 'mcp-trust.json'),
    JSON.stringify({
      version: 1,
      servers: {
        legacy: {
          fingerprint: fingerprintMcpLaunch(legacy),
          approvedAt: '2026-07-17T00:00:00.000Z',
        },
        dangling: {
          fingerprint: fingerprintMcpLaunch(dangling),
          approvedAt: '2026-07-17T00:00:00.000Z',
        },
      },
    }),
    'utf-8'
  )

  trustMcpLaunch(current)

  assert.equal(isMcpLaunchTrusted(legacy), true)
  assert.equal(isMcpLaunchTrusted(current), true)
  assert.equal(isMcpLaunchTrusted(dangling), true)

  const legacySidecar = join(coralHome, 'mcp-trust.d', 'legacy.json')
  await writeFile(legacySidecar, '{', 'utf-8')

  assert.equal(isMcpLaunchTrusted(legacy), false)
  assert.equal(isMcpLaunchTrusted(current), true)

  if (process.platform !== 'win32')
  {
    const danglingSidecar = join(coralHome, 'mcp-trust.d', 'dangling.json')
    await symlink('missing-trust-record.json', danglingSidecar)
    assert.equal(isMcpLaunchTrusted(dangling), false)
  }
})
