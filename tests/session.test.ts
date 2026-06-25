// tests/session.test.ts
// tests for session persistence

import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import type { OllamaMessage } from '../src/types/inference.js'
import type { TodoItem } from '../src/tools/todo-store.js'
import {
  createSession,
  saveSession,
  loadSession,
  listSessions,
  renameSession,
  type SessionData,
  type SessionMeta,
} from '../src/session/store.js'
import { resolveResumeSessionFromCandidates } from '../src/session/resume.js'
import { makeTempDirPool } from './helpers/temp.js'
import { captureCoralHome } from './helpers/coral-home.js'
import { makeSessionData, makeSessionMeta } from './helpers/session.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()

const makeMeta = (id: string, title?: string): SessionMeta =>
  makeSessionMeta(title === undefined ? { id } : { id, title })

const makeSession = (meta: SessionMeta): SessionData => makeSessionData(meta)

beforeEach(async () =>
{
  const dir = await tempDir('coral-sessions-')
  process.env.CORAL_HOME = dir
})

after(async () =>
{
  restoreCoralHome()
  await cleanup()
})

test('createSession and loadSession round-trip conversation state', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'What files are here?' },
    { role: 'assistant', content: 'Let me check.' },
    { role: 'tool', tool_name: 'list_files', content: 'src/\npackage.json' },
    { role: 'assistant', content: 'I see src/ and package.json.' },
  ]

  const meta = createSession('test-model', '/tmp/test-project', messages)
  const loaded = loadSession(meta.id)

  assert.ok(loaded)
  assert.equal(meta.title, 'What files are here?')
  assert.equal(meta.messageCount, 4)
  assert.equal(loaded.meta.id, meta.id)
  assert.equal(loaded.messages[3]!.tool_name, 'list_files')
})

test('saveSession preserves identity and updates stored messages', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'First message' },
    { role: 'assistant', content: 'Response' },
  ]

  const meta = createSession('test-model', '/tmp/test', messages)
  messages.push({ role: 'user', content: 'Second message' })
  messages.push({ role: 'assistant', content: 'Second response' })

  const updated = saveSession(meta.id, 'test-model', '/tmp/test', messages)
  const loaded = loadSession(meta.id)

  assert.equal(updated.id, meta.id)
  assert.equal(updated.createdAt, meta.createdAt)
  assert.equal(updated.title, 'First message')
  assert.ok(loaded)
  assert.equal(loaded.messages.length, 5)
})

test('createSession and saveSession round-trip the todo list', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Plan something' },
  ]
  const todos: TodoItem[] = [
    { content: 'first step', status: 'in_progress' },
    { content: 'second step', status: 'completed' },
  ]

  const meta = createSession('test-model', '/tmp/todos', messages, todos)
  const loaded = loadSession(meta.id)

  assert.ok(loaded)
  assert.deepEqual(loaded.todos, todos)

  const nextTodos: TodoItem[] = [{ content: 'only step', status: 'completed' }]
  saveSession(
    meta.id,
    'test-model',
    '/tmp/todos',
    messages,
    undefined,
    nextTodos
  )
  const reloaded = loadSession(meta.id)

  assert.ok(reloaded)
  assert.deepEqual(reloaded.todos, nextTodos)
})

test('loadSession tolerates legacy session files without a todos field', async () =>
{
  // simulate a pre-todos session file — no todos key on disk
  const dir = join(process.env.CORAL_HOME!, 'sessions')
  await mkdir(dir, { recursive: true })
  const legacy = {
    meta: makeMeta('1e6ac701'),
    messages: [{ role: 'system', content: 'System' }],
  }
  await writeFile(join(dir, '1e6ac701.json'), JSON.stringify(legacy))

  const loaded = loadSession('1e6ac701')

  assert.ok(loaded)
  assert.equal(loaded.todos, undefined)
})

test('loadSession treats objectless JSON session files as missing', async () =>
{
  const dir = join(process.env.CORAL_HOME!, 'sessions')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'nulljson.json'), 'null', 'utf-8')

  const loaded = loadSession('nulljson')

  assert.equal(loaded, undefined)
})

test('listSessions orders resume targets by newest update', async () =>
{
  const first = createSession('model-a', '/tmp/a', [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Session one' },
  ])

  await new Promise((resolve) => setTimeout(resolve, 10))

  const second = createSession('model-b', '/tmp/b', [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Session two' },
  ])

  const ids = listSessions().map((session) => session.id)

  assert.ok(ids.indexOf(second.id) < ids.indexOf(first.id))
})

test('renameSession updates the index without losing conversation data', () =>
{
  const meta = createSession('test-model', '/tmp/preserve', [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Preserve test' },
    { role: 'assistant', content: 'Response' },
  ])

  const renamed = renameSession(meta.id, 'New name')
  const indexed = listSessions().find((session) => session.id === meta.id)
  const loaded = loadSession(meta.id)

  assert.ok(renamed)
  assert.equal(indexed?.title, 'New name')
  assert.equal(renamed.createdAt, meta.createdAt)
  assert.ok(loaded)
  assert.equal(loaded.messages.length, 3)
})

test('resolveResumeSessionFromCandidates keeps exact-only CLI resolution', () =>
{
  const sessions = [makeMeta('abcd1234'), makeMeta('abce5678')]
  const result = resolveResumeSessionFromCandidates({
    requestedId: 'abcd',
    allowPrefix: false,
    sessions,
    loadSessionById: () => undefined,
  })

  assert.equal(result.type, 'not_found')
  if (result.type === 'not_found') assert.equal(result.requestedId, 'abcd')
})

test('resolveResumeSessionFromCandidates supports TUI prefix ambiguity', () =>
{
  const sessions = [makeMeta('abcd1234'), makeMeta('abce5678')]
  const result = resolveResumeSessionFromCandidates({
    requestedId: 'abc',
    allowPrefix: true,
    sessions,
    loadSessionById: () => undefined,
  })

  assert.equal(result.type, 'ambiguous')
  if (result.type === 'ambiguous')
  {
    assert.deepEqual(
      result.matches.map((session) => session.id),
      ['abcd1234', 'abce5678']
    )
  }
})

test('resolveResumeSessionFromCandidates guards the active session', () =>
{
  const current = makeMeta('abcd1234')
  const result = resolveResumeSessionFromCandidates({
    requestedId: current.id,
    currentSessionId: current.id,
    allowPrefix: true,
    sessions: [current],
    loadSessionById: () => undefined,
  })

  assert.equal(result.type, 'current')
})

test('resolveResumeSessionFromCandidates chooses latest non-current session', () =>
{
  const latest = makeMeta('bbbbbbbb')
  const current = makeMeta('aaaaaaaa')
  const result = resolveResumeSessionFromCandidates({
    currentSessionId: current.id,
    sessions: [current, latest],
    loadSessionById: () => undefined,
  })
  const onlyCurrent = resolveResumeSessionFromCandidates({
    currentSessionId: current.id,
    sessions: [current],
    loadSessionById: () => undefined,
  })

  assert.equal(result.type, 'target')
  if (result.type === 'target') assert.equal(result.session.id, latest.id)
  assert.equal(onlyCurrent.type, 'empty')
})

test('resolveResumeSessionFromCandidates falls back to disk-only sessions', () =>
{
  const diskOnly = makeMeta('feedface', 'Disk-only session')
  const result = resolveResumeSessionFromCandidates({
    requestedId: diskOnly.id,
    sessions: [],
    loadSessionById: (id) =>
      id === diskOnly.id ? makeSession(diskOnly) : undefined,
  })

  assert.equal(result.type, 'target')
  if (result.type === 'target')
    assert.equal(result.session.title, diskOnly.title)
})
