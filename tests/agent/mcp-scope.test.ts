// tests/agent/mcp-scope.test.ts
// causal tests for MCP scope admission and lifecycle ownership

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { defaultToolPermissions } from '../../src/config/permissions.js'
import type { AgentMcpManager } from '../../src/agent/contracts.js'
import {
  McpToolScope,
  type McpToolAdmission,
} from '../../src/agent/mcp-scope.js'
import type { ActiveMcpMode, McpServerState } from '../../src/mcp/types.js'
import type { Tool } from '../../src/tools/tool.js'

const dynamicTool: Tool = {
  name: 'mcp__fixture__echo',
  description: 'echo through the fixture server',
  parameters: { type: 'object', properties: {} },
  async execute()
  {
    return { output: 'echo' }
  },
}

const scopeConfig = {
  servers: [
    {
      alias: 'fixture',
      command: '/fixture/server',
      args: [],
      enabledTools: ['echo'],
      yoloTools: ['echo'],
      passEnv: [],
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
      launchCwd: '/fixture',
    },
  ],
  issues: [],
}

function managerStatus(state: McpServerState, mode: ActiveMcpMode = 'ask')
{
  return {
    mode,
    configIssues: [],
    servers: [
      {
        alias: 'fixture',
        state,
        configuredTools: ['echo'],
        yoloTools: ['echo'],
        availableTools: state === 'ready' ? ['mcp__fixture__echo'] : [],
        launchCwd: '/fixture',
        passEnv: [],
      },
    ],
  }
}

function admission(
  admit: McpToolAdmission['admit'],
  signal?: AbortSignal
): McpToolAdmission
{
  return {
    maxDynamicToolTokens: 1_024,
    signal,
    admit,
  }
}

test('McpToolScope keeps bootstrap lazy, deduplicated, and retryable until admission', async () =>
{
  const lifecycle = new AbortController()
  let factoryCalls = 0
  let initializeCalls = 0
  let releaseInitialization = () =>
  {}
  const firstInitialization = new Promise<Tool[]>((resolve) =>
  {
    releaseInitialization = () => resolve([dynamicTool])
  })
  let releaseRetirement = () =>
  {}
  const retirement = new Promise<void>((resolve) =>
  {
    releaseRetirement = resolve
  })
  const order: string[] = []
  let disposeCalls = 0
  const manager: AgentMcpManager = {
    initialize()
    {
      initializeCalls += 1
      return initializeCalls === 1
        ? firstInitialization
        : Promise.resolve([dynamicTool])
    },
    getStatus: () => managerStatus('ready'),
    dispose()
    {
      disposeCalls += 1
      order.push('dispose')
      return retirement
    },
  }
  const scope = new McpToolScope({
    mode: 'off',
    config: {
      servers: scopeConfig.servers,
      issues: [{ message: 'config-only status' }],
    },
    permissions: defaultToolPermissions(),
    baseTools: [],
    lifecycleSignal: lifecycle.signal,
    managerFactory: async () =>
    {
      factoryCalls += 1
      return manager
    },
  })

  assert.deepEqual(scope.getStatus(), {
    mode: 'off',
    configIssues: [{ message: 'config-only status' }],
    servers: [
      {
        alias: 'fixture',
        state: 'blocked',
        configuredTools: ['echo'],
        yoloTools: ['echo'],
        availableTools: [],
        launchCwd: '/fixture',
        passEnv: [],
        message: 'MCP is disabled for this Agent',
      },
    ],
  })
  await scope.bootstrap(admission(() => assert.fail('disabled admission')))
  assert.equal(factoryCalls, 0)

  let emptyYoloFactoryCalls = 0
  const emptyYoloScope = new McpToolScope({
    mode: 'yolo',
    config: {
      servers: [{ ...scopeConfig.servers[0]!, yoloTools: [] }],
      issues: [],
    },
    permissions: defaultToolPermissions(),
    baseTools: [],
    lifecycleSignal: new AbortController().signal,
    managerFactory: async () =>
    {
      emptyYoloFactoryCalls += 1
      return manager
    },
  })
  await emptyYoloScope.bootstrap(
    admission(() => assert.fail('empty yolo admission'))
  )
  assert.equal(emptyYoloFactoryCalls, 0)
  assert.equal(emptyYoloScope.getStatus().servers[0]?.state, 'blocked')
  await emptyYoloScope.dispose()

  await scope.transitionMode('ask', () => undefined)
  let firstAdmissionCalls = 0
  const first = scope.bootstrap(
    admission(() =>
    {
      firstAdmissionCalls += 1
      throw new Error('candidate prompt did not fit')
    })
  )
  const second = scope.bootstrap(
    admission(() => assert.fail('deduplicated caller admitted tools'))
  )
  const firstFailure = assert.rejects(first, /candidate prompt did not fit/)
  const secondFailure = assert.rejects(second, /candidate prompt did not fit/)
  releaseInitialization()
  await Promise.all([firstFailure, secondFailure])

  assert.equal(factoryCalls, 1)
  assert.equal(initializeCalls, 1)
  assert.equal(firstAdmissionCalls, 1)
  assert.equal(disposeCalls, 0)

  let installedSnapshot: readonly Tool[] | undefined
  await scope.bootstrap(
    admission((tools) =>
    {
      assert.equal(Object.isFrozen(tools), true)
      installedSnapshot = tools
    })
  )
  assert.equal(factoryCalls, 1)
  assert.equal(initializeCalls, 2)
  assert.deepEqual(
    installedSnapshot?.map((tool) => tool.name),
    [dynamicTool.name]
  )

  await scope.bootstrap(
    admission(() => assert.fail('installed manager admitted twice'))
  )
  assert.equal(initializeCalls, 2)
  assert.deepEqual(scope.getStatus(), managerStatus('ready'))

  const retiring = scope.retireCurrent(() => order.push('detach'))
  assert.deepEqual(order, ['detach', 'dispose'])
  assert.equal(disposeCalls, 1)

  let disposalSettled = false
  const disposing = scope.dispose().then(() =>
  {
    disposalSettled = true
  })
  assert.equal(scope.dispose(), scope.dispose())
  await Promise.resolve()
  assert.equal(disposalSettled, false)

  releaseRetirement()
  await Promise.all([retiring, disposing])
  assert.equal(disposalSettled, true)
  assert.equal(disposeCalls, 1)
  assert.equal(scope.getMode(), 'off')
})

test('McpToolScope retires aborted and unresolved bootstrap snapshots', async () =>
{
  const lifecycle = new AbortController()
  let releaseFactory: (manager: AgentMcpManager) => void = () =>
  {}
  const pendingFactory = new Promise<AgentMcpManager>((resolve) =>
  {
    releaseFactory = resolve
  })
  const disposed: string[] = []
  let factoryCalls = 0
  const factoryModes: ActiveMcpMode[] = []
  const managers: AgentMcpManager[] = [
    {
      async initialize()
      {
        return [dynamicTool]
      },
      getStatus: () => managerStatus('ready'),
      async dispose()
      {
        disposed.push('aborted')
      },
    },
    {
      async initialize()
      {
        return [dynamicTool]
      },
      getStatus: () => managerStatus('needs_trust'),
      async dispose()
      {
        disposed.push('needs_trust')
      },
    },
    {
      async initialize()
      {
        return [dynamicTool]
      },
      getStatus: () => managerStatus('needs_trust', 'yolo'),
      async dispose()
      {
        disposed.push('yolo_skipped')
      },
    },
  ]
  const scope = new McpToolScope({
    mode: 'ask',
    config: scopeConfig,
    permissions: defaultToolPermissions(),
    baseTools: [],
    lifecycleSignal: lifecycle.signal,
    managerFactory: async (mode) =>
    {
      factoryModes.push(mode)
      const index = factoryCalls++
      if (index === 0) return pendingFactory
      return managers[index]!
    },
  })

  const controller = new AbortController()
  let admissions = 0
  const aborted = scope.bootstrap(
    admission(() =>
    {
      admissions += 1
    }, controller.signal)
  )
  controller.abort()
  releaseFactory(managers[0]!)
  await aborted
  assert.deepEqual(disposed, ['aborted'])
  assert.equal(admissions, 0)

  await scope.bootstrap(
    admission(() =>
    {
      admissions += 1
    })
  )
  assert.deepEqual(disposed, ['aborted', 'needs_trust'])
  assert.equal(admissions, 0)

  await scope.transitionMode('yolo', () => undefined)
  await scope.bootstrap(
    admission(() =>
    {
      admissions += 1
    })
  )
  assert.equal(factoryCalls, 3)
  assert.equal(admissions, 1)
  assert.deepEqual(factoryModes, ['ask', 'ask', 'yolo'])

  await scope.dispose()
  assert.deepEqual(disposed, ['aborted', 'needs_trust', 'yolo_skipped'])
})

test('McpToolScope invalidates pending generations and joins their cleanup', async () =>
{
  const lifecycle = new AbortController()
  let releaseFirst: (manager: AgentMcpManager) => void = () =>
  {}
  const pendingFirst = new Promise<AgentMcpManager>((resolve) =>
  {
    releaseFirst = resolve
  })
  const disposed: string[] = []
  const firstManager: AgentMcpManager = {
    async initialize()
    {
      return [dynamicTool]
    },
    getStatus: () => managerStatus('ready'),
    async dispose()
    {
      disposed.push('stale')
    },
  }
  const nextManager: AgentMcpManager = {
    async initialize()
    {
      return [dynamicTool]
    },
    getStatus: () => managerStatus('ready', 'yolo'),
    async dispose()
    {
      disposed.push('current')
    },
  }
  let factoryCalls = 0
  const factoryModes: ActiveMcpMode[] = []
  const scope = new McpToolScope({
    mode: 'ask',
    config: scopeConfig,
    permissions: defaultToolPermissions(),
    baseTools: [],
    lifecycleSignal: lifecycle.signal,
    managerFactory: async (mode) =>
    {
      factoryModes.push(mode)
      factoryCalls++
      return factoryCalls === 1 ? pendingFirst : nextManager
    },
  })

  let staleAdmissions = 0
  const staleBootstrap = scope.bootstrap(
    admission(() =>
    {
      staleAdmissions++
    })
  )
  const retirement = scope.transitionMode('yolo', () => undefined)

  let currentAdmissions = 0
  await scope.bootstrap(
    admission(() =>
    {
      currentAdmissions++
    })
  )
  releaseFirst(firstManager)
  await Promise.all([staleBootstrap, retirement])

  assert.equal(factoryCalls, 2)
  assert.equal(staleAdmissions, 0)
  assert.equal(currentAdmissions, 1)
  assert.deepEqual(factoryModes, ['ask', 'yolo'])
  assert.deepEqual(disposed, ['stale'])

  await scope.dispose()
  assert.deepEqual(disposed, ['stale', 'current'])
})

test('McpToolScope retires managers when detach or disposal throws', async () =>
{
  const lifecycle = new AbortController()
  let disposeCalls = 0
  const scope = new McpToolScope({
    mode: 'ask',
    config: scopeConfig,
    permissions: defaultToolPermissions(),
    baseTools: [],
    lifecycleSignal: lifecycle.signal,
    managerFactory: async () => ({
      async initialize()
      {
        return [dynamicTool]
      },
      getStatus: () => managerStatus('ready'),
      async dispose()
      {
        disposeCalls++
      },
    }),
  })
  await scope.bootstrap(admission(() => undefined))

  await assert.rejects(
    scope.retireCurrent(() =>
    {
      throw new Error('detach failed')
    }),
    /detach failed/
  )
  assert.equal(disposeCalls, 1)
  await scope.dispose()
  assert.equal(disposeCalls, 1)

  const throwingFactoryModes: ActiveMcpMode[] = []
  let throwingFactoryCalls = 0
  let askAdmissions = 0
  let yoloAdmissions = 0
  let yoloDisposals = 0
  const throwingScope = new McpToolScope({
    mode: 'ask',
    config: scopeConfig,
    permissions: defaultToolPermissions(),
    baseTools: [],
    lifecycleSignal: new AbortController().signal,
    managerFactory: async (mode) =>
    {
      throwingFactoryModes.push(mode)
      throwingFactoryCalls++
      if (throwingFactoryCalls === 1)
      {
        return {
          async initialize()
          {
            return [dynamicTool]
          },
          getStatus: () => managerStatus('ready'),
          dispose()
          {
            throw new Error('dispose failed')
          },
        }
      }
      return {
        async initialize()
        {
          return [dynamicTool]
        },
        getStatus: () => managerStatus('ready', 'yolo'),
        async dispose()
        {
          yoloDisposals++
        },
      }
    },
  })
  await throwingScope.bootstrap(
    admission(() =>
    {
      askAdmissions++
    })
  )
  let threwSynchronously = false
  let failedRetirement: Promise<void> | undefined
  try
  {
    failedRetirement = throwingScope.transitionMode('yolo', () => undefined)
  }
  catch
  {
    threwSynchronously = true
  }
  assert.equal(threwSynchronously, false)
  assert.equal(throwingScope.getMode(), 'yolo')
  assert.ok(failedRetirement)
  await assert.rejects(failedRetirement, /dispose failed/)

  await throwingScope.bootstrap(
    admission(() =>
    {
      yoloAdmissions++
    })
  )
  await throwingScope.bootstrap(
    admission(() => assert.fail('fresh yolo manager admitted twice'))
  )
  assert.deepEqual(throwingFactoryModes, ['ask', 'yolo'])
  assert.equal(askAdmissions, 1)
  assert.equal(yoloAdmissions, 1)
  assert.deepEqual(throwingScope.getStatus(), managerStatus('ready', 'yolo'))

  await throwingScope.dispose()
  assert.equal(yoloDisposals, 1)
})
