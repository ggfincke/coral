// tests/acp/controller.test.ts
// prove Coral's first-party ACP lifecycle through the official SDK

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import type { AcceptedTurn, AgentEvents } from '../../src/agent/contracts.js'
import type {
  CoralInteractionMode,
  CoralRuntimeMode,
} from '../../src/acp/session-policy.js'
import type { McpConfigResolution } from '../../src/config/mcp.js'
import { CoralAcpController } from '../../src/acp/controller.js'
import { SessionPersistenceError } from '../../src/session/errors.js'
import {
  loadSession,
  retryProviderSessionSave,
  saveProviderSession,
  saveProviderSessionMetadata,
} from '../../src/session/store.js'
import type { SessionData } from '../../src/session/types.js'
import type {
  OllamaMessage,
  ReliabilityStats,
} from '../../src/types/inference.js'

type FakeRunMode =
  | 'complete'
  | 'failed'
  | 'iteration_limited'
  | 'missing_anchor'
  | 'permission'
  | 'wait_for_cancel'
  | 'wait_for_permission_cancel'
  | 'wait_for_tool_cancel'

interface FakeAgentHooks
{
  onBlocked?: () => void
  onDispose?: () => Promise<void>
  onMcpPreflight?: (signal?: AbortSignal) => Promise<void>
  onStart?: () => void
  onSwitch?: (model: string) => Promise<void>
}

function waitForAbort(signal?: AbortSignal): Promise<void>
{
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) =>
    signal?.addEventListener('abort', () => resolve(), { once: true })
  )
}

class FakeAcpAgent
{
  private messages: OllamaMessage[]
  private model: string
  private nextTurn = 0
  private readonly turnStarts = new Map<string, number>()
  private produced = false
  private runtimeMode: CoralRuntimeMode
  private interactionMode: CoralInteractionMode
  turnCount = 0

  constructor(
    model: string,
    private readonly cwd: string,
    restored: SessionData | undefined,
    private readonly mode: FakeRunMode,
    private readonly hooks: FakeAgentHooks,
    policy: {
      runtimeMode: CoralRuntimeMode
      interactionMode: CoralInteractionMode
    }
  )
  {
    const tail =
      restored?.messages[0]?.role === 'system'
        ? restored.messages.slice(1)
        : (restored?.messages ?? [])
    this.model = model
    this.runtimeMode = policy.runtimeMode
    this.interactionMode = policy.interactionMode
    this.messages = [
      { role: 'system', content: `System for ${model}` },
      ...structuredClone(tail),
    ]
  }

  acceptTurn(input: string): AcceptedTurn
  {
    const turnId = randomUUID()
    this.nextTurn++
    this.turnStarts.set(turnId, this.messages.length)
    this.messages.push({ role: 'user', content: input })
    this.turnCount++
    return {
      id: Symbol(turnId),
      input: { content: input },
    }
  }

  async runAcceptedTurn(
    _accepted: AcceptedTurn,
    events: AgentEvents,
    signal?: AbortSignal
  ): Promise<void>
  {
    this.hooks.onStart?.()
    if (this.mode === 'wait_for_cancel')
    {
      this.hooks.onBlocked?.()
      await waitForAbort(signal)
      events.onDone()
      return
    }

    if (
      this.mode === 'wait_for_tool_cancel' ||
      this.mode === 'wait_for_permission_cancel'
    )
    {
      const args = { command: 'wait' }
      events.onToolCall('bash', args, 0)
      this.hooks.onBlocked?.()
      if (this.mode === 'wait_for_permission_cancel')
      {
        try
        {
          await events.onToolApproval('bash', args, undefined, 0)
        }
        catch
        {
          // cancellation is the expected permission settlement in this mode
        }
      }
      else await waitForAbort(signal)
      events.onToolResult(
        'bash',
        '',
        signal?.aborted ? 'Tool call interrupted' : 'permission rejected',
        0
      )
      this.messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            function: { index: 0, name: 'bash', arguments: args },
          },
        ],
      })
      this.messages.push({
        role: 'tool',
        tool_name: 'bash',
        content: 'Error: Tool call interrupted',
      })
      events.onDone()
      return
    }

    if (this.mode === 'iteration_limited')
    {
      events.onIterationLimit?.()
      events.onDone()
      return
    }

    if (this.mode === 'failed')
    {
      const error = new Error('fake inference failed')
      events.onError(error)
      return
    }

    if (this.mode === 'permission')
    {
      const args = { path: 'result.txt', content: 'ok' }
      events.onToolCall('write_file', args, 0)
      const allowed = await events.onToolApproval(
        'write_file',
        args,
        undefined,
        0
      )
      events.onToolResult(
        'write_file',
        allowed ? 'wrote result.txt' : 'permission denied',
        allowed ? undefined : 'permission denied',
        0
      )
      this.messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            function: { index: 0, name: 'write_file', arguments: args },
          },
        ],
      })
      this.messages.push({
        role: 'tool',
        tool_name: 'write_file',
        content: allowed ? 'wrote result.txt' : 'permission denied',
      })
    }

    const response = `reply-${this.turnCount}`
    events.onToken(response)
    events.onUsage?.({
      promptTokens: 10,
      completionTokens: 4,
      totalPromptTokens: this.turnCount * 10,
      totalCompletionTokens: this.turnCount * 4,
      contextTokens: 14,
      totalPromptEvalDurationNs: 0,
      totalEvalDurationNs: 0,
    })
    this.messages.push({ role: 'assistant', content: response })
    this.produced = true
    events.onDone()
    return
  }

  async switchModel(model: string): Promise<void>
  {
    await this.hooks.onSwitch?.(model)
    this.model = model
    this.messages[0] = { role: 'system', content: `System for ${model}` }
  }

  getRuntimeMode(): CoralRuntimeMode
  {
    return this.runtimeMode
  }

  getInteractionMode(): CoralInteractionMode
  {
    return this.interactionMode
  }

  setRuntimeMode(mode: CoralRuntimeMode): void
  {
    this.runtimeMode = mode
  }

  async setInteractionMode(mode: CoralInteractionMode): Promise<void>
  {
    this.interactionMode = mode
  }

  async preflightClientMcp(signal?: AbortSignal): Promise<void>
  {
    await this.hooks.onMcpPreflight?.(signal)
  }

  restoreMessages(messages: OllamaMessage[]): void
  {
    this.messages = structuredClone(messages)
  }

  restoreUndoStack(): void
  {}

  getMessages(): OllamaMessage[]
  {
    if (this.mode === 'missing_anchor')
      throw new Error('cannot capture native snapshot')
    return structuredClone(this.messages)
  }

  getSettledTurnStartIndex(turnId: string): number | undefined
  {
    if (this.mode === 'missing_anchor') return undefined
    return this.turnStarts.get(turnId)
  }

  getTodos(): []
  {
    return []
  }

  exportUndoStateForPersistence(): { undo: []; redo: [] }
  {
    return { undo: [], redo: [] }
  }

  getModel(): string
  {
    return this.model
  }

  getCwd(): string
  {
    return this.cwd
  }

  getCompactionCount(): number
  {
    return 0
  }

  getLastCompactedAt(): null
  {
    return null
  }

  getFrozenPrefix(): { contextWindow: number }
  {
    return { contextWindow: 32_768 }
  }

  hasProducedTurn(): boolean
  {
    return this.produced
  }

  getReliabilityTelemetry(): Array<{
    model: string
    stats: ReliabilityStats
  }>
  {
    return []
  }

  async dispose(): Promise<void>
  {
    await this.hooks.onDispose?.()
  }
}

async function withCoralHome<T>(run: (cwd: string) => Promise<T>): Promise<T>
{
  const root = await mkdtemp(join(tmpdir(), 'coral-acp-test-'))
  const cwd = await mkdtemp(join(root, 'workspace-'))
  const original = process.env.CORAL_HOME
  process.env.CORAL_HOME = join(root, 'home')
  try
  {
    return await run(cwd)
  }
  finally
  {
    if (original === undefined) delete process.env.CORAL_HOME
    else process.env.CORAL_HOME = original
    await rm(root, { recursive: true, force: true })
  }
}

function controller(
  mode: FakeRunMode,
  overrides: {
    listModels?: (
      signal?: AbortSignal
    ) => Promise<import('../../src/types/inference.js').Model[]>
    loadSession?: typeof loadSession
    saveTurn?: typeof saveProviderSession
    saveMetadata?: typeof saveProviderSessionMetadata
    retryTurn?: typeof retryProviderSessionSave
  } = {},
  hooks: FakeAgentHooks = {}
): {
  controller: CoralAcpController
  agents: FakeAcpAgent[]
  mcpConfigs: McpConfigResolution[]
}
{
  const agents: FakeAcpAgent[] = []
  const mcpConfigs: McpConfigResolution[] = []
  const instance = new CoralAcpController(
    { host: 'http://ollama.test', model: 'model-a' },
    {
      createAgent: (model, cwd, restored, binding) =>
      {
        mcpConfigs.push(structuredClone(binding.mcpConfig))
        const agent = new FakeAcpAgent(
          model,
          cwd,
          restored,
          mode,
          hooks,
          binding
        )
        agents.push(agent)
        return agent
      },
      listModels: async () => [
        {
          name: 'model-a',
          size: 1,
          modified_at: '2026-01-01T00:00:00.000Z',
        },
        {
          name: 'model-b',
          size: 1,
          modified_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      ...overrides,
    }
  )
  return { controller: instance, agents, mcpConfigs }
}

function client(
  updates: acp.SessionNotification[],
  permission: 'allow' | 'reject' | 'wait' = 'allow',
  onPermission?: () => void
): acp.ClientApp
{
  return acp
    .client({ name: 'coral-test-client' })
    .onNotification(acp.methods.client.session.update, (context) =>
    {
      updates.push(context.params)
    })
    .onRequest(acp.methods.client.session.requestPermission, (context) =>
    {
      onPermission?.()
      const kind = permission === 'allow' ? 'allow_once' : 'reject_once'
      if (permission === 'wait')
      {
        return new Promise((resolve) =>
        {
          const reject = () =>
            resolve({
              outcome: {
                outcome: 'selected',
                optionId: context.params.options.find(
                  (option) => option.kind === 'reject_once'
                )!.optionId,
              },
            })
          if (context.signal.aborted) reject()
          else context.signal.addEventListener('abort', reject, { once: true })
        })
      }
      return {
        outcome: {
          outcome: 'selected',
          optionId: context.params.options.find(
            (option) => option.kind === kind
          )!.optionId,
        },
      }
    })
}

async function initialize(context: acp.ClientContext): Promise<void>
{
  const response = await context.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  })
  assert.deepEqual(response.agentCapabilities, {
    loadSession: false,
    promptCapabilities: {},
    mcpCapabilities: {},
    sessionCapabilities: { resume: {}, close: {} },
  })
  assert.equal(response.authMethods, undefined)
}

test('shutdown cancels pending session setup without acquiring a session', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    const started = Promise.withResolvers<void>()
    const run = controller('complete', {
      listModels: async (signal) =>
      {
        started.resolve()
        await waitForAbort(signal)
        signal?.throwIfAborted()
        return []
      },
    })
    await client([]).connectWith(run.controller.createApp(), async (cx) =>
    {
      await initialize(cx)
      const pending = assert.rejects(
        cx.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [],
        })
      )
      await started.promise
      await assert.rejects(
        cx.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [],
        }),
        /being prepared/
      )
      await run.controller.shutdown()
      await pending
      assert.equal(run.agents.length, 0)
      const { existsSync } = await import('node:fs')
      assert.equal(existsSync(join(process.env.CORAL_HOME!, 'sessions')), false)
    })
  })
})

test('official SDK lifecycle persists turns, model changes, and resume without replay', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    const updates: acp.SessionNotification[] = []
    const first = controller('complete')
    let sessionId = ''
    await client(updates).connectWith(
      first.controller.createApp(),
      async (cx) =>
      {
        await initialize(cx)
        const created = await cx.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [],
        })
        sessionId = created.sessionId
        assert.equal(first.agents.length, 1)

        const prompt = await cx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'first turn' }],
        })
        assert.equal(prompt.stopReason, 'end_turn')
        assert.deepEqual(prompt.usage, {
          totalTokens: 14,
          inputTokens: 10,
          outputTokens: 4,
        })

        const model = await cx.request(
          acp.methods.agent.session.setConfigOption,
          { sessionId, configId: 'model', value: 'model-b' }
        )
        assert.equal(model.configOptions[0]!.currentValue, 'model-b')
        await cx.request(acp.methods.agent.session.close, { sessionId })
      }
    )
    await first.controller.shutdown()

    const persisted = loadSessionForTest(sessionId)
    assert.equal(persisted.meta.model, 'model-b')
    assert.equal(persisted.meta.title, 'first turn')
    assert.equal(
      persisted.messages.filter((message) => message.role !== 'system').length,
      2
    )

    updates.length = 0
    const resumed = controller('complete')
    await client(updates).connectWith(
      resumed.controller.createApp(),
      async (cx) =>
      {
        await initialize(cx)
        await cx.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd,
          mcpServers: [],
        })
        assert.equal(updates.length, 0)
        const prompt = await cx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'second turn' }],
        })
        assert.equal(prompt.stopReason, 'end_turn')
        assert.deepEqual(prompt.usage, {
          totalTokens: 14,
          inputTokens: 10,
          outputTokens: 4,
        })
        await cx.request(acp.methods.agent.session.close, { sessionId })
      }
    )
    await resumed.controller.shutdown()
    const afterResume = loadSessionForTest(sessionId)
    assert.equal(afterResume.meta.messageCount, 4)
    assert.equal(afterResume.meta.title, 'first turn')
  })
})

test('ACP refuses client MCP and unsupported modes before running an Agent', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    const first = controller('complete')
    await client([]).connectWith(first.controller.createApp(), async (cx) =>
    {
      await initialize(cx)
      await assert.rejects(
        cx.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [
            {
              type: 'http',
              name: 'test',
              url: 'http://localhost:4560/mcp',
              headers: [],
            },
          ],
        }),
        /Client-supplied MCP/
      )
      assert.equal(first.agents.length, 0)
      const { sessionId } = await cx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      })
      await assert.rejects(
        cx.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'coral.runtime-mode',
          value: 'full-access',
        }),
        /only approval-required/
      )
      await assert.rejects(
        cx.request(acp.methods.agent.session.setMode, {
          sessionId,
          modeId: 'plan',
        }),
        /Unsupported/
      )
      await cx.request(acp.methods.agent.session.close, { sessionId })
    })
    await first.controller.shutdown()
  })
})

test('permission uses once-only options and persists the completed tool round', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    const updates: acp.SessionNotification[] = []
    const run = controller('permission')
    await client(updates).connectWith(
      run.controller.createApp(),
      async (cx) =>
      {
        await initialize(cx)
        const { sessionId } = await cx.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [],
        })
        const result = await cx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'write the file' }],
        })
        assert.equal(result.stopReason, 'end_turn')
        assert.ok(
          updates.some(
            ({ update }) =>
              update.sessionUpdate === 'tool_call' && update.kind === 'edit'
          )
        )
        assert.ok(
          updates.some(
            ({ update }) =>
              update.sessionUpdate === 'tool_call_update' &&
              update.status === 'completed'
          )
        )
        await cx.request(acp.methods.agent.session.close, { sessionId })
      }
    )
    await run.controller.shutdown()
  })
})

test('permission rejection fails closed and preserves the rejected tool round', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    const updates: acp.SessionNotification[] = []
    const run = controller('permission')
    await client(updates, 'reject').connectWith(
      run.controller.createApp(),
      async (cx) =>
      {
        await initialize(cx)
        const { sessionId } = await cx.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [],
        })
        const result = await cx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'do not write the file' }],
        })
        assert.equal(result.stopReason, 'end_turn')
        assert.ok(
          updates.some(
            ({ update }) =>
              update.sessionUpdate === 'tool_call_update' &&
              update.status === 'failed'
          )
        )
        await cx.request(acp.methods.agent.session.close, { sessionId })
      }
    )
    await run.controller.shutdown()
  })
})

test('cancel aborts the active inference and settles the prompt as cancelled', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    const started = Promise.withResolvers<void>()
    const run = controller(
      'wait_for_cancel',
      {},
      {
        onBlocked: () => started.resolve(),
      }
    )
    await client([]).connectWith(run.controller.createApp(), async (cx) =>
    {
      await initialize(cx)
      const { sessionId } = await cx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      })
      const prompt = cx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'wait' }],
      })
      await started.promise
      await cx.notify(acp.methods.agent.session.cancel, { sessionId })
      assert.equal((await prompt).stopReason, 'cancelled')
      await cx.request(acp.methods.agent.session.close, { sessionId })
    })
    await run.controller.shutdown()
  })
})

test('cancel also settles blocked tool execution and permission requests', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    for (const mode of [
      'wait_for_tool_cancel',
      'wait_for_permission_cancel',
    ] as const)
    {
      const blocked = Promise.withResolvers<void>()
      const permission = Promise.withResolvers<void>()
      const run = controller(
        mode,
        {},
        {
          onBlocked: () => blocked.resolve(),
        }
      )
      const permissionMode =
        mode === 'wait_for_permission_cancel' ? 'wait' : 'allow'
      await client([], permissionMode, () => permission.resolve()).connectWith(
        run.controller.createApp(),
        async (cx) =>
        {
          await initialize(cx)
          const { sessionId } = await cx.request(
            acp.methods.agent.session.new,
            { cwd, mcpServers: [] }
          )
          const prompt = cx.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: `cancel ${mode}` }],
          })
          await blocked.promise
          if (mode === 'wait_for_permission_cancel') await permission.promise
          await cx.notify(acp.methods.agent.session.cancel, { sessionId })
          assert.equal((await prompt).stopReason, 'cancelled')
          await cx.request(acp.methods.agent.session.close, { sessionId })
        }
      )
      await run.controller.shutdown()
    }
  })
})

test('iteration limits and failures map after the accepted turn is persisted', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    const limited = controller('iteration_limited')
    let limitedSession = ''
    await client([]).connectWith(limited.controller.createApp(), async (cx) =>
    {
      await initialize(cx)
      const created = await cx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      })
      limitedSession = created.sessionId
      const result = await cx.request(acp.methods.agent.session.prompt, {
        sessionId: limitedSession,
        prompt: [{ type: 'text', text: 'keep going' }],
      })
      assert.equal(result.stopReason, 'max_turn_requests')
      await cx.request(acp.methods.agent.session.close, {
        sessionId: limitedSession,
      })
    })
    await limited.controller.shutdown()
    assert.equal(loadSessionForTest(limitedSession).meta.messageCount, 1)

    const failed = controller('failed')
    let failedSession = ''
    await client([]).connectWith(failed.controller.createApp(), async (cx) =>
    {
      await initialize(cx)
      const created = await cx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      })
      failedSession = created.sessionId
      await assert.rejects(
        cx.request(acp.methods.agent.session.prompt, {
          sessionId: failedSession,
          prompt: [{ type: 'text', text: 'fail now' }],
        }),
        /fake inference failed/
      )
      await cx.request(acp.methods.agent.session.close, {
        sessionId: failedSession,
      })
    })
    await failed.controller.shutdown()
    assert.equal(loadSessionForTest(failedSession).meta.messageCount, 1)
  })
})

test('session policy changes are idle-only and close joins cancellation and disposal', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    const blocked = Promise.withResolvers<void>()
    const disposalStarted = Promise.withResolvers<void>()
    const releaseDisposal = Promise.withResolvers<void>()
    const run = controller(
      'wait_for_cancel',
      {},
      {
        onBlocked: () => blocked.resolve(),
        onDispose: async () =>
        {
          disposalStarted.resolve()
          await releaseDisposal.promise
        },
      }
    )
    await client([]).connectWith(run.controller.createApp(), async (cx) =>
    {
      await initialize(cx)
      const { sessionId } = await cx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      })
      const prompt = cx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'stay active' }],
      })
      await blocked.promise
      await assert.rejects(
        cx.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'model',
          value: 'model-b',
        }),
        /only while Coral is idle/
      )
      await assert.rejects(
        cx.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'coral.runtime-mode',
          value: 'full-access',
        }),
        /only while Coral is idle/
      )
      await assert.rejects(
        cx.request(acp.methods.agent.session.setMode, {
          sessionId,
          modeId: 'plan',
        }),
        /only while Coral is idle/
      )

      let closeSettled = false
      const close = cx
        .request(acp.methods.agent.session.close, { sessionId })
        .finally(() =>
        {
          closeSettled = true
        })
      assert.equal((await prompt).stopReason, 'cancelled')
      await disposalStarted.promise
      assert.equal(closeSettled, false)
      await assert.rejects(
        cx.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'model',
          value: 'model-b',
        }),
        /closing/
      )
      releaseDisposal.resolve()
      await close
      assert.equal(closeSettled, true)
    })
    await run.controller.shutdown()
  })
})

test('close joins a model switch and retries its exact failed metadata write', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    const switchStarted = Promise.withResolvers<void>()
    const releaseSwitch = Promise.withResolvers<void>()
    let firstInput:
      Parameters<typeof saveProviderSessionMetadata>[0] | undefined
    let metadataCalls = 0
    const run = controller(
      'complete',
      {
        saveMetadata: (input) =>
        {
          metadataCalls++
          if (!firstInput)
          {
            firstInput = input
            throw new SessionPersistenceError(
              'save_failed',
              'metadata save failed'
            )
          }
          assert.equal(input, firstInput)
          return saveProviderSessionMetadata(input)
        },
      },
      {
        onSwitch: async () =>
        {
          switchStarted.resolve()
          await releaseSwitch.promise
        },
      }
    )
    let sessionId = ''
    await client([]).connectWith(run.controller.createApp(), async (cx) =>
    {
      await initialize(cx)
      const created = await cx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      })
      sessionId = created.sessionId
      const changing = cx.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'model',
        value: 'model-b',
      })
      await switchStarted.promise
      const closing = cx.request(acp.methods.agent.session.close, { sessionId })
      releaseSwitch.resolve()
      await assert.rejects(changing, /metadata save failed/)
      await closing
      assert.equal(metadataCalls, 2)
      assert.equal(loadSessionForTest(sessionId).meta.model, 'model-b')
    })
    await run.controller.shutdown()

    const resumed = controller('complete')
    await client([]).connectWith(resumed.controller.createApp(), async (cx) =>
    {
      await initialize(cx)
      await cx.request(acp.methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers: [],
      })
      await cx.request(acp.methods.agent.session.close, { sessionId })
    })
    await resumed.controller.shutdown()
  })
})

test('resume rejects missing, corrupt, mismatched, and actively leased sessions', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    const otherCwd = await mkdtemp(join(dirname(cwd), 'other-workspace-'))
    const corruptId = 'feedface'
    const sessions = join(process.env.CORAL_HOME!, 'sessions')
    await mkdir(sessions, { recursive: true })
    await writeFile(join(sessions, `${corruptId}.json`), '{not json')

    const owner = controller('complete')
    let sessionId = ''
    await client([]).connectWith(
      owner.controller.createApp(),
      async (ownerCx) =>
      {
        await initialize(ownerCx)
        const created = await ownerCx.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [],
        })
        sessionId = created.sessionId
        const beforeResume = loadSessionForTest(sessionId)

        const contender = controller('complete')
        await client([]).connectWith(
          contender.controller.createApp(),
          async (contenderCx) =>
          {
            await initialize(contenderCx)
            await assert.rejects(
              contenderCx.request(acp.methods.agent.session.resume, {
                sessionId: 'deadbeef',
                cwd,
                mcpServers: [],
              }),
              /not found or is corrupt/
            )
            await assert.rejects(
              contenderCx.request(acp.methods.agent.session.resume, {
                sessionId: corruptId,
                cwd,
                mcpServers: [],
              }),
              /not found or is corrupt/
            )
            await assert.rejects(
              contenderCx.request(acp.methods.agent.session.resume, {
                sessionId,
                cwd: otherCwd,
                mcpServers: [],
              }),
              /different working directory/
            )
            await assert.rejects(
              contenderCx.request(acp.methods.agent.session.resume, {
                sessionId,
                cwd,
                mcpServers: [],
              }),
              /already in use/
            )

            await ownerCx.request(acp.methods.agent.session.close, {
              sessionId,
            })
            const resumed = await contenderCx.request(
              acp.methods.agent.session.resume,
              { sessionId, cwd, mcpServers: [] }
            )
            assert.equal(resumed.configOptions[0]!.currentValue, 'model-a')
            const afterResume = loadSessionForTest(sessionId)
            assert.deepEqual(afterResume.messages, beforeResume.messages)
            await contenderCx.request(acp.methods.agent.session.close, {
              sessionId,
            })
          }
        )
        await contender.controller.shutdown()
      }
    )
    await owner.controller.shutdown()
  })
})

test('resume conservatively recovers a lease left by a dead provider process', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        "import { createSessionRuntimeIdentity } from './src/session/lease.ts'; import { createProviderSession } from './src/session/store.ts'; const created = createProviderSession({ model: 'model-a', cwd: process.env.TEST_WORKSPACE, runtime: createSessionRuntimeIdentity() }); process.stdout.write(created.session.meta.id)",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, TEST_WORKSPACE: cwd },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) =>
    {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) =>
    {
      stderr += chunk
    })
    const [exitCode, signal] = (await once(child, 'exit')) as [
      number | null,
      NodeJS.Signals | null,
    ]
    assert.equal(signal, null)
    assert.equal(exitCode, 0, stderr)
    assert.match(stdout, /^[0-9a-f]{8}$/)

    const resumed = controller('complete')
    await client([]).connectWith(resumed.controller.createApp(), async (cx) =>
    {
      await initialize(cx)
      await cx.request(acp.methods.agent.session.resume, {
        sessionId: stdout,
        cwd,
        mcpServers: [],
      })
      await cx.request(acp.methods.agent.session.close, { sessionId: stdout })
    })
    await resumed.controller.shutdown()
  })
})

test('failed strict save blocks another turn until the exact write retries', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    let failRetry = true
    let failInitialSave = true
    let failedInput: Parameters<typeof saveProviderSession>[0] | undefined
    const run = controller('complete', {
      saveTurn: (input) =>
      {
        if (failInitialSave)
        {
          failInitialSave = false
          failedInput = input
          throw new SessionPersistenceError('save_failed', 'first save failed')
        }
        return saveProviderSession(input)
      },
      retryTurn: (input: Parameters<typeof retryProviderSessionSave>[0]) =>
      {
        assert.equal(input, failedInput)
        if (failRetry)
        {
          throw new SessionPersistenceError('save_failed', 'retry failed')
        }
        return saveProviderSession(input)
      },
    })
    await client([]).connectWith(run.controller.createApp(), async (cx) =>
    {
      await initialize(cx)
      const { sessionId } = await cx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      })
      await assert.rejects(
        cx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'first' }],
        }),
        /persist/
      )
      assert.equal(run.agents[0]!.turnCount, 1)
      await assert.rejects(
        cx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'must not be admitted' }],
        }),
        /persist/
      )
      assert.equal(run.agents[0]!.turnCount, 1)

      failRetry = false
      const recovered = await cx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'second' }],
      })
      assert.equal(recovered.stopReason, 'end_turn')
      assert.equal(run.agents[0]!.turnCount, 2)
      await cx.request(acp.methods.agent.session.close, { sessionId })
    })
    await run.controller.shutdown()
  })
})

test('snapshot faults are non-recoverable but close still releases the lease', async () =>
{
  await withCoralHome(async (cwd) =>
  {
    const broken = controller('missing_anchor')
    let sessionId = ''
    await client([]).connectWith(broken.controller.createApp(), async (cx) =>
    {
      await initialize(cx)
      const created = await cx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      })
      sessionId = created.sessionId
      await assert.rejects(
        cx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'cannot snapshot' }],
        }),
        /cannot capture native snapshot/
      )
      await assert.rejects(
        cx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'must stay blocked' }],
        }),
        /cannot capture native snapshot/
      )
      assert.equal(broken.agents[0]!.turnCount, 1)
      await assert.rejects(
        cx.request(acp.methods.agent.session.close, { sessionId }),
        /cannot capture native snapshot/
      )
    })
    await broken.controller.shutdown()

    const recovered = controller('complete')
    await client([]).connectWith(
      recovered.controller.createApp(),
      async (cx) =>
      {
        await initialize(cx)
        await cx.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd,
          mcpServers: [],
        })
        await cx.request(acp.methods.agent.session.close, { sessionId })
      }
    )
    await recovered.controller.shutdown()
  })
})

function loadSessionForTest(sessionId: string): SessionData
{
  const session = loadSession(sessionId)
  assert.ok(session)
  return session
}
