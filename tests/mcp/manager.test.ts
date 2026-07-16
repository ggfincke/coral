// tests/mcp/manager.test.ts
// major Agent-mediated stdio bridge & abort/lifecycle scenarios

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { parseMcpConfig } from '../../src/config/mcp.js'
import { defaultToolPermissions } from '../../src/config/permissions.js'
import { McpManager } from '../../src/mcp/manager.js'
import { allTools } from '../../src/tools/index.js'
import type { ChatRequest, OllamaMessage } from '../../src/types/inference.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeAgentEvents, makeFakeAgent } from '../helpers/agent-harness.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()
const originalToken = process.env.CORAL_MCP_TEST_TOKEN
const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'mcp-stdio-server.js'
)

after(async () =>
{
  restoreCoralHome()
  if (originalToken === undefined)
  {
    delete process.env.CORAL_MCP_TEST_TOKEN
  }
  else
  {
    process.env.CORAL_MCP_TEST_TOKEN = originalToken
  }
  await cleanup()
})

function processExists(pid: number): boolean
{
  try
  {
    process.kill(pid, 0)
    return true
  }
  catch
  {
    return false
  }
}

async function waitForProcessExit(pid: number): Promise<void>
{
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline)
  {
    if (!processExists(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`MCP fixture process ${pid} did not exit`)
}

async function fixturePid(path: string): Promise<number>
{
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline)
  {
    if (existsSync(path)) return Number(await readFile(path, 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('MCP fixture did not record its pid')
}

function managerFor(
  alias: string,
  tool: string,
  pidPath: string,
  toolTimeoutMs = 5_000
): McpManager
{
  const config = parseMcpConfig({
    servers: {
      [alias]: {
        command: process.execPath,
        args: [fixture, pidPath],
        enabledTools: [tool],
        passEnv: ['CORAL_MCP_TEST_TOKEN'],
        startupTimeoutMs: 5_000,
        toolTimeoutMs,
      },
    },
  })
  assert.deepEqual(config.issues, [])
  return new McpManager({
    config,
    permissions: defaultToolPermissions(),
    baseTools: allTools,
  })
}

test('MCP stdio bridge exposes only strict allowlisted namespaced tools', async () =>
{
  const coralHome = await tempDir('coral-mcp-bridge-home-')
  const workspace = await tempDir('coral-mcp-bridge-ws-')
  const pidPath = join(coralHome, 'bridge.pid')
  process.env.CORAL_HOME = coralHome
  process.env.CORAL_MCP_TEST_TOKEN = 'bridge-\x1b[31m-value'

  const mcpConfig = parseMcpConfig({
    servers: {
      fixture: {
        command: process.execPath,
        args: [fixture, pidPath],
        enabledTools: ['echo'],
        passEnv: ['CORAL_MCP_TEST_TOKEN'],
        startupTimeoutMs: 5_000,
        toolTimeoutMs: 5_000,
      },
    },
  })
  assert.deepEqual(mcpConfig.issues, [])

  // request-inspecting fake model: each turn asserts what the model actually
  // sees at the request boundary, then drives the next leg of the scenario
  const mcpToolNames = (request?: ChatRequest) =>
    (request?.tools ?? [])
      .map((tool) => tool.function.name)
      .filter((name) => name.startsWith('mcp__'))
  const lastMessage = (request?: ChatRequest): OllamaMessage | undefined =>
    request?.messages[request.messages.length - 1]
  const echoCall = (args: Record<string, unknown>) => ({
    message: {
      role: 'assistant' as const,
      content: '',
      tool_calls: [
        { function: { name: 'mcp__fixture__echo', arguments: args } },
      ],
    },
    done: false,
  })
  const doneChunk = {
    message: { role: 'assistant' as const, content: 'ok' },
    done: true,
  }

  let turn = 0
  const { agent } = makeFakeAgent(
    workspace,
    async function* (request)
    {
      turn += 1
      if (turn === 1)
      {
        // discovery reached the model: sanitized namespaced tool & system prompt
        assert.deepEqual(mcpToolNames(request), ['mcp__fixture__echo'])
        assert.equal(
          (request?.tools ?? []).some((tool) =>
            tool.function.name.includes('hidden')
          ),
          false
        )
        const echo = request?.tools?.find(
          (tool) => tool.function.name === 'mcp__fixture__echo'
        )
        assert.match(echo?.function.description ?? '', /\[redacted\]/)
        assert.doesNotMatch(
          JSON.stringify(echo?.function.parameters ?? {}),
          /bridge|\\u001b|\[31m/
        )
        assert.match(
          String(request?.messages[0]?.content),
          /mcp__fixture__echo/
        )
        // valid 2020-12 tuple: a draft-07 validator falsely rejects prefixItems
        yield echoCall({
          payload: { message: 'hi', count: 2 },
          pair: ['a', 1],
        })
        return
      }
      if (turn === 2)
      {
        const result = lastMessage(request)
        assert.equal(result?.role, 'tool')
        assert.match(result?.content ?? '', /echo:hihi/)
        assert.match(
          result?.content ?? '',
          /unsupported MCP image content: image\/png/
        )
        assert.match(result?.content ?? '', /embedded resource text/)
        // launch CWD is exactly the neutral home directory
        assert.ok(
          result?.content?.includes(`"cwd": ${JSON.stringify(homedir())}`)
        )
        assert.match(result?.content ?? '', /"envForwarded": true/)
        // structured output carries the tuple through output validation
        assert.match(result?.content ?? '', /"pair"/)
        assert.doesNotMatch(result?.content ?? '', /bridge|\\u001b|\[31m/)
        assert.match(result?.content ?? '', /"forwardedValue": "\[redacted\]"/)
        // strictly-invalid-but-coercible args must fail strict MCP validation
        yield echoCall({
          payload: { message: 'x', count: '2' },
          pair: ['a', 1],
        })
        return
      }
      if (turn === 3)
      {
        const result = lastMessage(request)
        assert.equal(result?.role, 'tool')
        // the strict AJV error reached the model & the fixture never ran
        assert.match(
          result?.content ?? '',
          /Invalid arguments for mcp__fixture__echo/
        )
        assert.doesNotMatch(result?.content ?? '', /echo:x/)
        yield doneChunk
        return
      }
      if (turn === 4)
      {
        // disabled: no dynamic tools advertised
        assert.deepEqual(mcpToolNames(request), [])
        yield doneChunk
        return
      }
      // turn 5 (re-enabled): tools reinstall on the next chat turn
      assert.deepEqual(mcpToolNames(request), ['mcp__fixture__echo'])
      yield doneChunk
    },
    { mcp: true, mcpConfig, numCtx: 8_192 }
  )
  agent.client.unloadModel = async () => undefined

  let launchApprovals = 0
  let approvalCheckedBeforeSpawn = false
  const approvalLabels: string[] = []
  const callLabels: string[] = []
  const events = makeAgentEvents({
    onMcpLaunchApproval: async (request) =>
    {
      launchApprovals += 1
      approvalCheckedBeforeSpawn = !existsSync(pidPath)
      assert.equal(request.alias, 'fixture')
      assert.equal(request.launchCwd, homedir())
      assert.deepEqual(request.passEnv, ['CORAL_MCP_TEST_TOKEN'])
      assert.equal(request.fingerprint.length, 64)
      return true
    },
    onToolApproval: (_name, _args, presentation) =>
    {
      if (presentation?.mcp) approvalLabels.push(presentation.label)
      return Promise.resolve(true)
    },
    onToolCall: (_name, _args, _callId, presentation) =>
    {
      if (presentation?.mcp) callLabels.push(presentation.label)
    },
  })

  await agent.run('use the echo tool', events, undefined)
  assert.equal(turn, 3)
  assert.equal(launchApprovals, 1)
  assert.equal(approvalCheckedBeforeSpawn, true)
  // the dynamic display snapshot reaches call & approval events
  assert.deepEqual(callLabels, ['MCP · fixture · echo', 'MCP · fixture · echo'])
  assert.deepEqual(approvalLabels, callLabels)
  const stderr = agent.getMcpStatus().servers[0]?.stderr ?? ''
  assert.match(stderr, /\[redacted\]/)
  assert.doesNotMatch(stderr, /bridge|31m|value/)

  // disable exits the child & removes the dynamic tools from requests
  const pid = await fixturePid(pidPath)
  await agent.setMcpEnabled(false)
  await waitForProcessExit(pid)
  await agent.run('and now?', events, undefined)
  assert.equal(turn, 4)

  // re-enable reinstalls on the next turn from persisted trust: fresh process,
  // no second launch prompt
  await agent.setMcpEnabled(true)
  await agent.run('back again', events, undefined)
  assert.equal(turn, 5)
  const newPid = await fixturePid(pidPath)
  assert.notEqual(newPid, pid)
  assert.equal(launchApprovals, 1)

  await agent.dispose()
  await waitForProcessExit(newPid)
})

test('MCP abort retires the server and disposal leaves no child process', async () =>
{
  const coralHome = await tempDir('coral-mcp-lifecycle-home-')
  const readyPidPath = join(coralHome, 'startup-ready.pid')
  const pendingPidPath = join(coralHome, 'startup-pending.pid')
  const pidPath = join(coralHome, 'lifecycle.pid')
  process.env.CORAL_HOME = coralHome
  process.env.CORAL_MCP_TEST_TOKEN = 'bridge-\x1b[31m-value'

  const startupConfig = parseMcpConfig({
    servers: {
      startup_ready: {
        command: process.execPath,
        args: [fixture, readyPidPath],
        enabledTools: ['echo'],
        passEnv: ['CORAL_MCP_TEST_TOKEN'],
      },
      startup_pending: {
        command: process.execPath,
        args: [fixture, pendingPidPath],
        enabledTools: ['slow'],
        passEnv: ['CORAL_MCP_TEST_TOKEN'],
      },
    },
  })
  const startupManager = new McpManager({
    config: startupConfig,
    permissions: defaultToolPermissions(),
    baseTools: allTools,
  })
  const startupController = new AbortController()
  const startupTools = await startupManager.initialize({
    signal: startupController.signal,
    async onLaunchApproval(request)
    {
      if (request.alias === 'startup_ready') return true
      queueMicrotask(() => startupController.abort())
      return new Promise<boolean>(() =>
      {})
    },
  })
  const readyPid = await fixturePid(readyPidPath)
  assert.deepEqual(startupTools, [])
  assert.equal(existsSync(pendingPidPath), false)
  assert.equal(startupManager.getStatus().servers[0]?.state, 'stopped')
  await waitForProcessExit(readyPid)
  await startupManager.dispose()

  const manager = managerFor('lifecycle', 'slow', pidPath, 10_000)
  const tools = await manager.initialize({
    onLaunchApproval: async () => true,
  })
  const pid = await fixturePid(pidPath)
  const controller = new AbortController()
  const call = tools[0]!.execute(
    { delayMs: 30_000 },
    {
      cwd: process.cwd(),
      ollamaHost: 'http://localhost:11434',
      signal: controller.signal,
    }
  )
  setTimeout(() => controller.abort(), 50)

  await assert.rejects(call)
  const status = manager.getStatus().servers[0]
  assert.equal(status?.state, 'stopped')
  assert.match(status?.message ?? '', /interrupted/)
  await waitForProcessExit(pid)
  await manager.dispose()
  await manager.dispose()
})
