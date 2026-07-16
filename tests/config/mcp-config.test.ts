// tests/config/mcp-config.test.ts
// MCP launch config & trust boundary integration test

import { strict as assert } from 'node:assert'
import { stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseMcpConfig } from '../../src/config/mcp.js'
import { defaultToolPermissions } from '../../src/config/permissions.js'
import { loadProjectConfig } from '../../src/config/project-config.js'
import { McpManager } from '../../src/mcp/manager.js'
import {
  isMcpLaunchTrusted,
  trustMcpLaunch,
  type McpLaunchDescriptor,
} from '../../src/mcp/trust.js'
import { allTools } from '../../src/tools/index.js'
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
  assert.equal(projectConfig.permissions?.mcp__github__get_me, 'always_deny')

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

  const unsafeToolName = parseMcpConfig({
    servers: {
      unsafe: {
        command: 'node',
        enabledTools: ['get_\x1b[31msecret'],
      },
    },
  })
  assert.match(unsafeToolName.issues[0]?.message ?? '', /invalid value/)

  const server = resolved.servers[0]!
  const descriptor: McpLaunchDescriptor = {
    alias: server.alias,
    command: server.command,
    executable: '/usr/local/bin/docker',
    args: server.args,
    launchCwd: server.launchCwd,
    passEnv: server.passEnv,
    enabledTools: server.enabledTools,
  }

  assert.equal(isMcpLaunchTrusted(descriptor), false)
  trustMcpLaunch(descriptor)
  assert.equal(isMcpLaunchTrusted(descriptor), true)
  assert.equal(
    isMcpLaunchTrusted({ ...descriptor, args: [...descriptor.args, '--pull'] }),
    false
  )

  if (process.platform !== 'win32')
  {
    const info = await stat(join(coralHome, 'mcp-trust.json'))
    assert.equal(info.mode & 0o777, 0o600)
  }

  // exact always_deny blocks a fully-denied server before launch approval,
  // executable resolution, or any process spawn
  const deniedConfig = parseMcpConfig({
    servers: {
      denied: { command: 'node', enabledTools: ['list'] },
    },
  })
  assert.deepEqual(deniedConfig.issues, [])
  const deniedManager = new McpManager({
    config: deniedConfig,
    permissions: {
      ...defaultToolPermissions(),
      mcp__denied__list: 'always_deny',
    },
    baseTools: allTools,
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
