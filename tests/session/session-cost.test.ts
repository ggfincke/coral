// tests/session/session-cost.test.ts
// protect durable spending and background session ownership

import { strict as assert } from 'node:assert'
import { after, beforeEach, test } from 'node:test'
import type { Agent } from '../../src/agent/agent.js'
import type { AgentInferenceClient } from '../../src/agent/inference-client.js'
import { SessionInferenceClient } from '../../src/agent/session-cost.js'
import type { SessionData } from '../../src/session/types.js'
import {
  decodeSessionData,
  encodeSessionData,
} from '../../src/session/codec.js'
import { loadSession, renameSession } from '../../src/session/store.js'
import {
  buildPrimaryAgent,
  forkAgentSession,
  persistAgentSession,
  SessionTitleGenerator,
} from '../../src/tui/session/agent-session.js'
import { buildProviderTurnSaveInput } from '../../src/acp/persistence.js'
import { makeAgentEvents } from '../helpers/agent-harness.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { captureCoralHome } from '../helpers/coral-home.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreHome = captureCoralHome()
const agents: Agent[] = []

beforeEach(async () =>
{
  process.env.CORAL_HOME = await tempDir('coral-cost-home-')
})
after(async () =>
{
  for (const agent of agents) await agent.dispose()
  restoreHome()
  await cleanup()
})

function client(gate?: Promise<void>): AgentInferenceClient
{
  return {
    startKeepAlive()
    {},
    showModel: async () => ({
      contextLength: 200_000,
      hosted: { maxOutputTokens: 1000 },
    }),
    listModels: async () => [],
    async *chatStream(request)
    {
      if (gate) await gate
      yield {
        message: { role: 'assistant', content: '' },
        done: false,
        billingUsage: {
          model: request.model,
          serviceTier: 'standard',
          inputTokens: 1000,
          cacheReadTokens: 0,
          cacheWriteShortTokens: 0,
          cacheWriteLongTokens: 0,
          outputTokens: 100,
        },
      }
      yield {
        message: { role: 'assistant', content: 'Fixture answer' },
        done: true,
        prompt_eval_count: 1000,
        eval_count: 100,
      }
    },
  }
}

function primary(
  cwd: string,
  inferenceClient = client(),
  restored?: SessionData
): Agent
{
  const agent = buildPrimaryAgent({
    model: restored?.meta.model ?? 'anthropic/claude-opus-5-5',
    cwd,
    host: 'http://localhost:11434',
    think: true,
    mcpMode: 'off',
    mcpConfig: { servers: [], issues: [] },
    inferenceClient,
    restored,
  })
  agents.push(agent)
  return agent
}

test('costs survive persistence, undo/redo, model switching, and resume; forks and new sessions start fresh', async () =>
{
  const cwd = await tempDir('coral-cost-workspace-')
  const agent = primary(cwd)
  await agent.run('first task', makeAgentEvents())
  const before = agent.getSessionCost()
  assert.equal(before.entries[0]!.usd, 0.006)
  assert.equal((await agent.undoLastTurn()).ok, true)
  agent.resetTokenUsage()
  assert.deepEqual(agent.getSessionCost(), before)
  assert.equal((await agent.redoLastTurn()).ok, true)
  agent.resetTokenUsage()
  assert.deepEqual(agent.getSessionCost(), before)
  assert.equal(agent.getTokenUsage().promptTokens, 0)

  await agent.switchModel('openai/gpt-6.1-sol')
  await agent.run('second task', makeAgentEvents())
  const meta = persistAgentSession(agent, null)!
  assert.ok(meta)
  renameSession(meta.id, 'Explicit title')
  const stored = loadSession(meta.id)!
  assert.deepEqual(stored.sessionCost, agent.getSessionCost())
  const resumed = primary(cwd, client(), stored)
  assert.deepEqual(resumed.getSessionCost(), agent.getSessionCost())
  await resumed.run('third task', makeAgentEvents())
  assert.equal(resumed.getSessionCost().entries[1]!.requests, 2)
  assert.equal(resumed.getSessionCost().entries[1]!.usd, 0.006)
  const saved = persistAgentSession(resumed, stored.meta)!
  assert.equal(saved.title, 'Explicit title')

  const providerInput = buildProviderTurnSaveInput(
    resumed,
    loadSession(meta.id)!,
    {
      sessionId: meta.id,
      token: 'fixture-lease',
    } as Parameters<typeof buildProviderTurnSaveInput>[2]
  )
  assert.deepEqual(providerInput.snapshot.sessionCost, resumed.getSessionCost())

  let forked: SessionData | undefined
  const fork = forkAgentSession(
    resumed,
    resumed.getUndoStack()[0]!.startIndex,
    {
      isCurrent: () => true,
      saveParent: () => persistAgentSession(resumed, saved),
      adopt: (child) =>
      {
        forked = child
        return true
      },
    }
  )
  assert.equal(fork.status, 'forked')
  assert.deepEqual(forked!.sessionCost!.entries, [])
  assert.deepEqual(loadSession(meta.id)!.sessionCost, resumed.getSessionCost())
  resumed.clearHistory()
  resumed.resetSessionMetrics()
  assert.deepEqual(resumed.getSessionCost().entries, [])
  assert.ok(loadSession(meta.id)!.sessionCost!.entries.length > 0)
})

test('legacy coverage is explicit and invalid persisted costs cannot enter a session', async () =>
{
  const cwd = await tempDir('coral-cost-legacy-')
  const original = primary(cwd)
  await original.run('old task', makeAgentEvents())
  const meta = persistAgentSession(original, null)!
  const legacy = loadSession(meta.id)!
  delete legacy.sessionCost
  const agent = primary(cwd, client(), legacy)
  assert.equal(agent.getSessionCost().historicalUsageUnknown, true)
  assert.deepEqual(agent.getSessionCost().entries, [])
  await agent.run('new tracked task', makeAgentEvents())
  const saved = persistAgentSession(agent, legacy.meta)!
  const loaded = loadSession(saved.id)!
  assert.equal(loaded.sessionCost!.historicalUsageUnknown, true)
  assert.equal(loaded.sessionCost!.entries[0]!.requests, 1)
  const invalid = structuredClone(loaded)
  invalid.sessionCost!.entries[0]!.usd = -1
  assert.equal(decodeSessionData(encodeSessionData(invalid)), undefined)
  invalid.sessionCost!.entries[0]!.usd = Number.POSITIVE_INFINITY
  assert.equal(decodeSessionData(invalid), undefined)
})

test('cancelled background titles settle and save their original session before adoption', async () =>
{
  const cwd = await tempDir('coral-cost-titles-')
  const owner = primary(cwd)
  await owner.run('first exchange', makeAgentEvents())
  const meta = persistAgentSession(owner, null)!
  const other = primary(cwd)
  let release = () =>
  {}
  const gate = new Promise<void>((resolve) =>
  {
    release = resolve
  })
  const raw = client(gate)
  const ownerClient = owner.getSessionInferenceClient()
  assert.ok(ownerClient instanceof SessionInferenceClient)
  // gate only the title transport while retaining the original cost owner
  const bound = new SessionInferenceClient(raw, ownerClient.costs)
  let active = meta.id
  let settled = 0
  const generator = new SessionTitleGenerator({
    client: other.getSessionInferenceClient(),
    isActiveSession: (id) => id === active,
    applyTitle: (id, title) =>
    {
      renameSession(id, title)
    },
    onSettled: (id) =>
    {
      assert.equal(id, meta.id)
      persistAgentSession(owner, loadSession(id)!.meta)
      settled++
    },
  })
  generator.offer(meta, owner.getModel(), undefined, 8192, bound)
  const cancellation = generator.cancel()
  release()
  await cancellation
  active = 'new-session'
  assert.equal(settled, 1)
  assert.equal(owner.getSessionCost().entries[0]!.requests, 2)
  assert.equal(loadSession(meta.id)!.sessionCost!.entries[0]!.requests, 2)
  assert.deepEqual(other.getSessionCost().entries, [])
  assert.equal(loadSession(meta.id)!.meta.title, meta.title)
})
