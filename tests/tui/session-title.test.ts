// tests/tui/session-title.test.ts
// background session-title sanitizer, prompt bounds, & generate-once guards

import { strict as assert } from 'node:assert'
import { after, beforeEach, test } from 'node:test'
import type { AgentInferenceClient } from '../../src/agent/inference-client.js'
import type { ChatRequest } from '../../src/types/inference.js'
import {
  extractFirstExchange,
  requestSessionTitle,
  sanitizeSessionTitle,
  SessionTitleGenerator,
} from '../../src/tui/session/agent-session.js'
import {
  createSession,
  loadSession,
  renameSession,
} from '../../src/session/store.js'
import type { SessionMeta } from '../../src/session/types.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { captureCoralHome } from '../helpers/coral-home.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()

beforeEach(async () =>
{
  const dir = await tempDir('coral-session-title-')
  process.env.CORAL_HOME = dir
})

after(async () =>
{
  restoreCoralHome()
  await cleanup()
})

interface FakeClient
{
  client: AgentInferenceClient
  requests: ChatRequest[]
  calls: () => number
}

function fakeClient(reply = 'Fix auth flow', gate?: Promise<void>): FakeClient
{
  const requests: ChatRequest[] = []
  let calls = 0
  const client: AgentInferenceClient = {
    startKeepAlive()
    {},
    showModel: async () =>
    {
      throw new Error('unused')
    },
    listModels: async () => [],
    async *chatStream(request)
    {
      calls += 1
      requests.push(request)
      if (gate) await gate
      yield { message: { role: 'assistant', content: reply }, done: true }
    },
  }
  return { client, requests, calls: () => calls }
}

function throwingClient(): AgentInferenceClient
{
  return {
    startKeepAlive()
    {},
    showModel: async () =>
    {
      throw new Error('unused')
    },
    listModels: async () => [],
    async *chatStream()
    {
      throw new Error('ollama down')
      yield { message: { role: 'assistant', content: '' }, done: true }
    },
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function makeGenerator(
  client: AgentInferenceClient,
  applied?: string[][],
  active = true
): SessionTitleGenerator
{
  return new SessionTitleGenerator({
    client,
    isActiveSession: () => active,
    applyTitle: (id, title) =>
    {
      applied?.push([id, title])
      renameSession(id, title)
    },
  })
}

test('sanitizeSessionTitle strips controls, collapses whitespace, & caps', () =>
{
  assert.equal(
    sanitizeSessionTitle('\x07\nFix\tauth\r\nflow\x1b[2J'),
    'Fix auth flow [2J'
  )
  assert.equal(sanitizeSessionTitle('   spaced   out   '), 'spaced out')
  assert.equal(sanitizeSessionTitle(''), null)
  assert.equal(sanitizeSessionTitle(' \n\t '), null)

  const capped = sanitizeSessionTitle('word '.repeat(40))
  assert.ok(capped !== null)
  assert.equal(capped.length, 60)
  assert.ok(capped.endsWith('…'))
})

test('extractFirstExchange bounds the payload & skips tool traffic', () =>
{
  const longPrompt = 'x'.repeat(800)
  const longReply = 'y'.repeat(400)
  const exchange = extractFirstExchange([
    { role: 'system', content: 'System' },
    { role: 'user', content: longPrompt },
    { role: 'assistant', content: '' },
    { role: 'tool', tool_name: 'read_file', content: 'noise' },
    { role: 'assistant', content: longReply },
  ])

  assert.ok(exchange)
  assert.equal(exchange.user.length, 500)
  assert.ok(exchange.user.endsWith('…'))
  assert.equal(exchange.assistant.length, 300)
  assert.ok(!exchange.assistant.includes('noise'))

  // displayContent wins over expanded attachment text
  const display = extractFirstExchange([
    {
      role: 'user',
      content: 'expanded attachment blob',
      displayContent: '@notes.md',
    },
    { role: 'assistant', content: 'done' },
  ])
  assert.equal(display?.user, '@notes.md')

  assert.equal(
    extractFirstExchange([{ role: 'assistant', content: 'no user' }]),
    null
  )
  assert.equal(
    extractFirstExchange([{ role: 'user', content: 'never answered' }]),
    null
  )
})

test('requestSessionTitle sends one schema-less call and sanitizes output', async () =>
{
  const { client, requests } = fakeClient('  Fix\nauth\tflow  ')
  const title = await requestSessionTitle(client, 'm1', {
    user: 'fix the login redirect',
    assistant: 'patched the router',
  })

  assert.equal(title, 'Fix auth flow')
  assert.equal(requests.length, 1)
  assert.deepEqual(
    requests[0]!.messages.map((message) => message.role),
    ['system', 'user']
  )
  assert.match(requests[0]!.messages[0]!.content, /^Write a 3-6 word title/)
  assert.ok(requests[0]!.messages[1]!.content.includes('login redirect'))

  const failed = await requestSessionTitle(throwingClient(), 'm1', {
    user: 'u',
    assistant: 'a',
  })
  assert.equal(failed, null)
})

test('first exchange generates once and applies via the write-back path', async () =>
{
  const meta: SessionMeta = createSession('test-model', process.cwd(), [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'please fix the login redirect bug' },
    { role: 'assistant', content: 'Fixed the redirect in router.ts.' },
  ])
  const applied: string[][] = []
  const { client, calls } = fakeClient()
  const generator = makeGenerator(client, applied)

  generator.offer(meta, 'test-model')
  await settle()
  await settle()

  assert.equal(calls(), 1)
  assert.deepEqual(applied, [[meta.id, 'Fix auth flow']])
  assert.equal(loadSession(meta.id)?.meta.title, 'Fix auth flow')

  // a second settled turn never regenerates for the same session
  generator.offer(meta, 'test-model')
  await settle()
  assert.equal(calls(), 1)
  assert.equal(generator.hasAttempted(meta.id), true)
})

test('explicit renames block generation before & mid-flight', async () =>
{
  const preRenamed = createSession('test-model', process.cwd(), [
    { role: 'user', content: 'untitled work' },
    { role: 'assistant', content: 'done' },
  ])
  renameSession(preRenamed.id, 'Custom name')

  const preApplied: string[][] = []
  const preClient = fakeClient()
  makeGenerator(preClient.client, preApplied).offer(preRenamed, 'test-model')
  await settle()
  await settle()

  assert.equal(preClient.calls(), 0)
  assert.deepEqual(preApplied, [])
  assert.equal(loadSession(preRenamed.id)?.meta.title, 'Custom name')

  // a rename landing while the model is generating also wins
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) =>
  {
    releaseGate = resolve
  })
  const racing = createSession('test-model', process.cwd(), [
    { role: 'user', content: 'racing rename' },
    { role: 'assistant', content: 'done too' },
  ])
  const raceApplied: string[][] = []
  const raceClient = fakeClient('Late title', gate)
  makeGenerator(raceClient.client, raceApplied).offer(racing, 'test-model')
  await settle()

  renameSession(racing.id, 'User Renamed')
  releaseGate()
  await settle()
  await settle()

  assert.equal(raceClient.calls(), 1)
  assert.deepEqual(raceApplied, [])
  assert.equal(loadSession(racing.id)?.meta.title, 'User Renamed')
})

test('failures stay silent and inactive sessions skip the write-back', async () =>
{
  const failing = createSession('test-model', process.cwd(), [
    { role: 'user', content: 'boom case' },
    { role: 'assistant', content: 'ok' },
  ])
  const failApplied: string[][] = []
  makeGenerator(throwingClient(), failApplied).offer(failing, 'test-model')
  await settle()
  await settle()

  assert.deepEqual(failApplied, [])
  assert.equal(loadSession(failing.id)?.meta.title, 'boom case')

  const inactive = createSession('test-model', process.cwd(), [
    { role: 'user', content: 'switched away' },
    { role: 'assistant', content: 'ok' },
  ])
  const inactiveApplied: string[][] = []
  const inactiveCalls = fakeClient()
  makeGenerator(inactiveCalls.client, inactiveApplied, false).offer(
    inactive,
    'test-model'
  )
  await settle()
  await settle()

  assert.equal(inactiveCalls.calls(), 1)
  assert.deepEqual(inactiveApplied, [])
  assert.notEqual(loadSession(inactive.id)?.meta.title, 'Fix auth flow')
})
