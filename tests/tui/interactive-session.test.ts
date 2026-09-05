// tests/tui/interactive-session.test.ts
// major interactive lifecycle generation, prompt, persistence, & cleanup tests

import { strict as assert } from 'node:assert'
import { after, beforeEach, test } from 'node:test'
import { makeReliabilityStats } from '../../src/types/inference.js'
import {
  InteractiveSessionRuntime,
  sessionToolGrantFingerprint,
  type ActivePrompt,
  type InteractiveLifetimeAgent,
  type PromptSettlement,
} from '../../src/tui/session/interactive-runtime.js'
import { resolveStartupSession } from '../../src/tui/session/agent-session.js'
import type { SessionMeta } from '../../src/session/types.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeSessionMeta } from '../helpers/session.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()

beforeEach(async () =>
{
  process.env.CORAL_HOME = await tempDir('coral-interactive-session-')
})

after(async () =>
{
  restoreCoralHome()
  await cleanup()
})

interface Deferred
{
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred
{
  let resolve = () =>
  {}
  const promise = new Promise<void>((done) =>
  {
    resolve = done
  })
  return { promise, resolve }
}

class FakeAgent implements InteractiveLifetimeAgent
{
  disposeCalls = 0
  produced = true
  reliability = 0

  constructor(
    readonly name: string,
    private readonly disposal: Promise<void> = Promise.resolve()
  )
  {}

  async dispose(): Promise<void>
  {
    this.disposeCalls++
    await this.disposal
  }

  hasProducedTurn(): boolean
  {
    return this.produced
  }

  getReliabilityTelemetry()
  {
    return [
      {
        model: this.name,
        stats: makeReliabilityStats({ doomLoopTrips: this.reliability }),
      },
    ]
  }
}

function makeRuntime(
  agent: FakeAgent,
  initialSession: SessionMeta | null,
  overrides: {
    persist?: (
      agent: FakeAgent,
      target: SessionMeta | null
    ) => SessionMeta | null
    recordTelemetry?: (model: string, trips: number) => void
    onPromptChange?: (prompt: ActivePrompt | null) => void
  } = {}
): InteractiveSessionRuntime<FakeAgent>
{
  return new InteractiveSessionRuntime(
    {
      persist:
        overrides.persist ??
        ((_agent, target) => target ?? makeSessionMeta({ id: 'feedface' })),
      recordTelemetry: (model, stats) =>
        overrides.recordTelemetry?.(model, stats.doomLoopTrips),
      onPromptChange: overrides.onPromptChange ?? (() => undefined),
      onSessionChange: () => undefined,
      onTransitionChange: () => undefined,
    },
    agent,
    initialSession
  )
}

test('blocking prompts settle once across answer, abort, & replacement', async () =>
{
  const prompts: Array<ActivePrompt | null> = []
  const first = new FakeAgent('first')
  const runtime = makeRuntime(first, null, {
    onPromptChange: (prompt) => prompts.push(prompt),
  })

  const toolRun = runtime.beginOperation('turn')
  assert.ok(toolRun)
  const toolAnswer = runtime.requestPrompt(toolRun, {
    kind: 'tool',
    toolName: 'bash',
    args: { command: 'npm test' },
  })
  const toolPrompt = prompts.at(-1)
  assert.equal(toolPrompt?.kind, 'tool')
  assert.equal(runtime.settlePrompt(toolPrompt!.id, true), true)
  assert.equal(runtime.settlePrompt(toolPrompt!.id, false), false)
  assert.equal(await toolAnswer, true)
  assert.equal(runtime.completeTurn(toolRun).accepted, true)

  const mcpRun = runtime.beginOperation('turn')
  assert.ok(mcpRun)
  const mcpAnswer = runtime.requestPrompt(mcpRun, {
    kind: 'mcp',
    request: {
      alias: 'fixture',
      command: 'node',
      executable: '/usr/bin/node',
      args: [],
      launchCwd: '/tmp',
      passEnv: [],
      enabledTools: ['echo'],
      yoloTools: ['echo'],
      fingerprint: 'f'.repeat(64),
    },
  })
  assert.equal(runtime.abortActive(), true)
  assert.equal(runtime.abortActive(), false)
  assert.equal(await mcpAnswer, false)
  assert.equal(runtime.completeTurn(mcpRun).aborted, true)

  const doomRun = runtime.beginOperation('turn')
  assert.ok(doomRun)
  const doomAnswer = runtime.requestPrompt(doomRun, {
    kind: 'doom',
    message: 'Repeated failure',
  })
  const second = new FakeAgent('second')
  await runtime.replaceAgent(second, makeSessionMeta({ id: 'beadbead' }))
  assert.equal(await doomAnswer, false)
  assert.equal(runtime.completeTurn(doomRun).accepted, false)
  assert.equal(
    await runtime.requestPrompt(doomRun, {
      kind: 'tool',
      toolName: 'write_file',
      args: {},
    }),
    false
  )
  assert.equal(prompts.at(-1), null)

  const shutdownRun = runtime.beginOperation('turn')
  assert.ok(shutdownRun)
  const shutdownAnswer = runtime.requestPrompt(shutdownRun, {
    kind: 'doom',
    message: 'Shutting down',
  })
  const shutdownPrompt = prompts.at(-1)
  assert.equal(shutdownPrompt?.kind, 'doom')
  await runtime.shutdown()
  assert.equal(await shutdownAnswer, false)
  assert.equal(runtime.settlePrompt(shutdownPrompt!.id, true), false)
  assert.equal(runtime.completeTurn(shutdownRun).accepted, false)
  assert.equal(prompts.at(-1), null)
})

test('operation admission and captured session binding reject retired terminals', async () =>
{
  const sessionA = makeSessionMeta({ id: 'aaaaaaaa' })
  const sessionB = makeSessionMeta({ id: 'bbbbbbbb' })
  const writes: Array<{ agent: string; target: string | null }> = []
  const first = new FakeAgent('first')
  const runtime = makeRuntime(first, sessionA, {
    persist(agent, target)
    {
      writes.push({ agent: agent.name, target: target?.id ?? null })
      return target ?? makeSessionMeta({ id: 'cccccccc' })
    },
  })

  const runA = runtime.beginOperation('turn')
  assert.ok(runA)
  assert.equal(runtime.beginOperation('turn'), null)
  assert.equal(runtime.beginTransition('model'), null)

  // even a same-Agent binding change cannot redirect the initiating turn
  runtime.replaceSession(sessionB)
  const completion = runtime.completeTurn(runA)
  assert.equal(completion.accepted, true)
  assert.deepEqual(writes, [{ agent: 'first', target: 'aaaaaaaa' }])
  assert.equal(runtime.getSessionId(), 'bbbbbbbb')
  assert.equal(runtime.completeTurn(runA).accepted, false)

  const retired = runtime.beginOperation('turn')
  assert.ok(retired)
  const second = new FakeAgent('second')
  void runtime.replaceAgent(second, sessionB)
  assert.equal(runtime.completeTurn(retired).accepted, false)
  assert.deepEqual(writes, [{ agent: 'first', target: 'aaaaaaaa' }])

  const active = runtime.beginOperation('turn')
  assert.ok(active)
  assert.equal(runtime.completeTurn(active).accepted, true)
  assert.deepEqual(writes.at(-1), { agent: 'second', target: 'bbbbbbbb' })

  const transition = runtime.beginTransition('model')
  assert.ok(transition)
  assert.equal(runtime.beginTransition('session'), null)
  assert.equal(runtime.beginOperation('turn'), null)
  assert.equal(runtime.finishTransition(transition), true)
  assert.equal(runtime.finishTransition(transition), false)

  const admittedAfterTransition = runtime.beginOperation('command')
  assert.ok(admittedAfterTransition)
  const commandTransition = runtime.beginTransition('model')
  assert.equal(commandTransition, null)
  const ownedCommandTransition = runtime.beginTransition(
    'model',
    admittedAfterTransition
  )
  assert.ok(ownedCommandTransition)
  assert.equal(runtime.finishTransition(ownedCommandTransition), true)
  assert.equal(runtime.finishCommand(admittedAfterTransition), true)

  const abortedCommand = runtime.beginOperation('command')
  assert.ok(abortedCommand)
  assert.equal(runtime.abortActive(), true)
  assert.equal(runtime.beginTransition('permission', abortedCommand), null)
  assert.equal(runtime.finishCommand(abortedCommand), true)

  const resumeCommand = runtime.beginOperation('command')
  assert.ok(resumeCommand)
  const third = new FakeAgent('third')
  const closeSecond = runtime.replaceAgent(third, sessionA, {
    preserveCommand: true,
  })
  assert.equal(resumeCommand.signal.aborted, false)
  assert.equal(runtime.acceptsCommandEvent(resumeCommand), true)
  assert.equal(runtime.beginOperation('turn'), null)
  assert.equal(runtime.finishCommand(resumeCommand), true)
  assert.equal(runtime.acceptsCommandEvent(resumeCommand), false)

  const admittedAfterResume = runtime.beginOperation('turn')
  assert.ok(admittedAfterResume)
  assert.equal(runtime.completeTurn(admittedAfterResume).accepted, true)
  await closeSecond
})

test('rapid replacement joins disposal before folding telemetry exactly once', async () =>
{
  const disposeA = deferred()
  const disposeB = deferred()
  const disposeC = deferred()
  const transitionWork = deferred()
  const first = new FakeAgent('first', disposeA.promise)
  const second = new FakeAgent('second', disposeB.promise)
  const third = new FakeAgent('third', disposeC.promise)
  const folded: Array<{ model: string; trips: number }> = []
  const runtime = makeRuntime(first, null, {
    recordTelemetry: (model, trips) => folded.push({ model, trips }),
  })

  const closeA = runtime.replaceAgent(second, null)
  const closeB = runtime.replaceAgent(third, null)
  const transition = runtime.beginTransition('session')
  assert.ok(transition)
  const trackedTransition = runtime.trackTransition(
    transition,
    transitionWork.promise
  )
  const shutdownA = runtime.shutdown()
  const shutdownB = runtime.shutdown()

  first.reliability = 1
  second.reliability = 2
  third.reliability = 3
  await Promise.resolve()
  assert.deepEqual(folded, [])

  disposeA.resolve()
  disposeB.resolve()
  await Promise.all([closeA, closeB])
  assert.equal(third.disposeCalls, 0)

  transitionWork.resolve()
  await trackedTransition
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(third.disposeCalls, 1)
  disposeC.resolve()
  await Promise.all([shutdownA, shutdownB])

  assert.equal(first.disposeCalls, 1)
  assert.equal(second.disposeCalls, 1)
  assert.equal(third.disposeCalls, 1)
  assert.deepEqual(
    folded.sort((left, right) => left.model.localeCompare(right.model)),
    [
      { model: 'first', trips: 1 },
      { model: 'second', trips: 2 },
      { model: 'third', trips: 3 },
    ]
  )
})

test('shutdown joins command settlement and permits exact terminal persistence', async () =>
{
  const work = deferred()
  const writes: string[] = []
  const agent = new FakeAgent('command-agent')
  const runtime = makeRuntime(agent, makeSessionMeta({ id: 'aaaaaaaa' }), {
    persist(savedAgent, target)
    {
      writes.push(`${savedAgent.name}:${target?.id ?? 'new'}`)
      return target
    },
  })
  const command = runtime.beginOperation('command')
  assert.ok(command)

  let shutdownPromise!: Promise<void>
  const commandTask = runtime.runOperation(command, async () =>
  {
    shutdownPromise = runtime.shutdown()
    await work.promise
    assert.equal(command.signal.aborted, true)
    assert.equal(runtime.acceptsCommandEvent(command), false)
    assert.equal(runtime.acceptsCommandTerminal(command), true)
    assert.equal(runtime.saveOperation(command)?.id, 'aaaaaaaa')
    runtime.finishCommand(command)
  })

  await Promise.resolve()
  let shutdownSettled = false
  void shutdownPromise.then(() =>
  {
    shutdownSettled = true
  })
  await Promise.resolve()
  assert.equal(shutdownSettled, false)
  assert.equal(agent.disposeCalls, 0)

  work.resolve()
  await commandTask
  await shutdownPromise
  assert.equal(shutdownSettled, true)
  assert.equal(agent.disposeCalls, 1)
  assert.deepEqual(writes, ['command-agent:aaaaaaaa'])
})

test('a missing startup resume ID produces no saved session binding', () =>
{
  assert.equal(resolveStartupSession('deadbeef').session, null)
})

test('session grants fingerprint tool identity w/ a server qualifier for MCP', () =>
{
  assert.equal(sessionToolGrantFingerprint('bash'), 'bash')
  assert.notEqual(
    sessionToolGrantFingerprint('bash'),
    sessionToolGrantFingerprint('write_file')
  )
  // dynamic MCP names embed their stable server qualifier
  assert.equal(
    sessionToolGrantFingerprint('mcp__fixture__echo', {
      label: 'echo',
      mcp: true,
    }),
    'mcp:mcp__fixture__echo'
  )
  assert.equal(
    sessionToolGrantFingerprint('mcp__fixture__echo'),
    'mcp:mcp__fixture__echo'
  )
  assert.notEqual(
    sessionToolGrantFingerprint('mcp__fixture__echo'),
    sessionToolGrantFingerprint('mcp__other__echo')
  )
})

test('always-approvals grant identical tool calls without prompting until reset', async () =>
{
  const prompts: Array<ActivePrompt | null> = []
  const agent = new FakeAgent('grants')
  const runtime = makeRuntime(agent, makeSessionMeta({ id: 'aaaaaa11' }), {
    onPromptChange: (prompt) => prompts.push(prompt),
  })
  const published = () => prompts.filter(Boolean).length
  const settle = (settlement: PromptSettlement) =>
  {
    const prompt = prompts.at(-1)
    assert.ok(prompt && prompt.kind === 'tool')
    assert.equal(runtime.settlePrompt(prompt.id, settlement), true)
    return prompt
  }

  const run = runtime.beginOperation('turn')
  assert.ok(run)

  // the first bash call publishes a prompt; 'a' settles allow-always & records
  const first = runtime.requestToolApproval(run, {
    toolName: 'bash',
    args: { command: 'npm test' },
  })
  assert.equal(published(), 1)
  settle({ approved: true, always: true })
  assert.equal(await first, true)

  // a grant hit auto-approves w/o publishing any prompt; args are irrelevant
  // because grants fingerprint tool identity only
  assert.equal(
    await runtime.requestToolApproval(run, {
      toolName: 'bash',
      args: { command: 'rm -rf /tmp/x' },
    }),
    true
  )
  assert.equal(published(), 1)

  // a different tool does not match the grant; plain reject records nothing,
  // so it prompts again and a plain y settles w/o recording an always-grant
  const second = runtime.requestToolApproval(run, {
    toolName: 'write_file',
    args: {},
  })
  assert.equal(published(), 2)
  settle(false)
  assert.equal(await second, false)

  const third = runtime.requestToolApproval(run, {
    toolName: 'write_file',
    args: {},
  })
  assert.equal(published(), 3)
  settle(true)
  assert.equal(await third, true)

  // an MCP grant stays scoped to its server qualifier
  const mcp = runtime.requestToolApproval(run, {
    toolName: 'mcp__fixture__echo',
    args: {},
    presentation: { label: 'echo', mcp: true },
  })
  assert.equal(published(), 4)
  const mcpPrompt = prompts.at(-1)!
  settle({ approved: true, always: true })
  assert.equal(await mcp, true)
  assert.equal(
    await runtime.requestToolApproval(run, {
      toolName: 'mcp__fixture__echo',
      args: { text: 'again' },
      presentation: { label: 'echo', mcp: true },
    }),
    true
  )
  assert.equal(published(), 4)

  const otherServer = runtime.requestToolApproval(run, {
    toolName: 'mcp__other__echo',
    args: {},
    presentation: { label: 'echo', mcp: true },
  })
  assert.equal(prompts.at(-1)!.id > mcpPrompt.id, true)
  settle(false)
  assert.equal(await otherServer, false)

  // the widened channel resolves an always-settlement object verbatim
  const raw = runtime.requestPrompt(run, {
    kind: 'tool',
    toolName: 'grep',
    args: {},
  })
  assert.equal(published(), 6)
  const rawSettlement = settle({ approved: true, always: true })
  assert.deepEqual(await raw, { approved: true, always: true })
  assert.equal(rawSettlement.id > mcpPrompt.id, true)

  // a session reset clears every recorded grant
  runtime.replaceSession(makeSessionMeta({ id: 'bbbbbb22' }))
  const afterReset = runtime.requestToolApproval(run, {
    toolName: 'bash',
    args: { command: 'npm test' },
  })
  assert.equal(prompts.at(-1)?.kind, 'tool')
  settle(true)
  assert.equal(await afterReset, true)

  await runtime.shutdown()
})
