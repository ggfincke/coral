// tests/session/session.test.ts
// tests for session persistence

import { strict as assert } from 'node:assert'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import type { OllamaMessage } from '../../src/types/inference.js'
import type { TodoItem } from '../../src/tools/todo-store.js'
import type { UndoTurn } from '../../src/types/undo.js'
import {
  MAX_UNDO_TURNS,
  serializeUndoState,
} from '../../src/session/undo-state.js'
import {
  createSession,
  saveSession,
  loadSession,
  listSessions,
  renameSession,
  type SessionData,
  type SessionMeta,
} from '../../src/session/store.js'
import { resolveResumeSessionFromCandidates } from '../../src/session/resume.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeSessionData, makeSessionMeta } from '../helpers/session.js'

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

test('createSession and saveSession round-trip undo and redo stacks', async () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Create file' },
    { role: 'assistant', content: 'Done' },
  ]
  const undo: UndoTurn[] = [
    {
      startIndex: 1,
      endIndex: 3,
      userMessage: 'Create file',
      messages: messages.slice(1),
      changes: [{ path: '/tmp/file.txt', before: null, after: 'hello\n' }],
      todoChange: {
        before: [{ content: 'old todo', status: 'pending' }],
        after: [{ content: 'new todo', status: 'in_progress' }],
      },
    },
  ]
  const redo: UndoTurn[] = [
    {
      startIndex: 1,
      endIndex: 3,
      userMessage: 'Edit file',
      messages: [
        { role: 'user', content: 'Edit file' },
        { role: 'assistant', content: 'Edited' },
      ],
      changes: [
        { path: '/tmp/file.txt', before: 'hello\n', after: 'goodbye\n' },
      ],
    },
  ]

  const meta = createSession(
    'test-model',
    '/tmp/undo',
    messages,
    [],
    undo,
    redo
  )
  const loaded = loadSession(meta.id)
  const raw = JSON.parse(
    await readFile(
      join(process.env.CORAL_HOME!, 'sessions', `${meta.id}.json`),
      'utf-8'
    )
  ) as {
    undo: Array<{ messages?: unknown }>
    redo: Array<{ messages?: unknown }>
  }

  assert.ok(loaded)
  assert.equal(raw.undo[0]?.messages, undefined)
  assert.ok(Array.isArray(raw.redo[0]?.messages))
  assert.deepEqual(loaded.undo, undo)
  assert.deepEqual(loaded.redo, redo)

  const nextUndo = undo.map((turn) => ({ ...turn, userMessage: 'Updated' }))
  saveSession(
    meta.id,
    'test-model',
    '/tmp/undo',
    messages,
    undefined,
    [],
    nextUndo,
    []
  )
  const reloaded = loadSession(meta.id)

  assert.ok(reloaded)
  assert.deepEqual(reloaded.undo, nextUndo)
  assert.deepEqual(reloaded.redo, [])
})

test('serializeUndoState caps persisted undo records by whole newest turns', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Large turn' },
    { role: 'assistant', content: 'Done' },
    { role: 'user', content: 'Small turn' },
    { role: 'assistant', content: 'Done' },
  ]
  const largeTurn: UndoTurn = {
    startIndex: 1,
    endIndex: 3,
    userMessage: 'Large turn',
    messages: messages.slice(1, 3),
    changes: [
      { path: '/tmp/a.txt', before: null, after: 'x'.repeat(1_000) },
      { path: '/tmp/b.txt', before: null, after: 'y'.repeat(1_000) },
    ],
  }
  const smallTurn: UndoTurn = {
    startIndex: 3,
    endIndex: 5,
    userMessage: 'Small turn',
    messages: messages.slice(3, 5),
    changes: [{ path: '/tmp/c.txt', before: null, after: 'ok\n' }],
  }

  const capped = serializeUndoState(messages, [largeTurn, smallTurn], [], {
    byteCap: 500,
  })
  const tinyCap = serializeUndoState(messages, [smallTurn], [], {
    byteCap: 20,
  })

  assert.deepEqual(
    capped.undo.map((turn) => turn.userMessage),
    ['Small turn']
  )
  assert.deepEqual(capped.undo[0]?.changes, smallTurn.changes)
  assert.deepEqual(tinyCap.undo, [])
})

test('serializeUndoState applies MAX_UNDO_TURNS before the byte cap', () =>
{
  const messages: OllamaMessage[] = [{ role: 'system', content: 'System' }]
  const turns: UndoTurn[] = []
  for (let i = 0; i < MAX_UNDO_TURNS + 3; i++)
  {
    const startIndex = 1 + i * 2
    const endIndex = startIndex + 2
    messages.push(
      { role: 'user', content: `Turn ${i}` },
      { role: 'assistant', content: 'Done' }
    )
    turns.push({
      startIndex,
      endIndex,
      userMessage: `Turn ${i}`,
      messages: messages.slice(startIndex, endIndex),
      changes: [{ path: `/tmp/t${i}.txt`, before: null, after: 'ok\n' }],
    })
  }

  const persisted = serializeUndoState(messages, turns, [])

  assert.equal(persisted.undo.length, MAX_UNDO_TURNS)
  assert.equal(persisted.undo[0]?.userMessage, `Turn ${3}`)
  assert.equal(persisted.undo.at(-1)?.userMessage, `Turn ${MAX_UNDO_TURNS + 2}`)
})

test(
  'session JSON and containing directories use private POSIX modes',
  { skip: process.platform === 'win32' },
  async () =>
  {
    const meta = createSession('test-model', '/tmp/private', [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Private state' },
    ])
    const homeMode = (await stat(process.env.CORAL_HOME!)).mode & 0o777
    const sessionsMode =
      (await stat(join(process.env.CORAL_HOME!, 'sessions'))).mode & 0o777
    const sessionMode =
      (await stat(join(process.env.CORAL_HOME!, 'sessions', `${meta.id}.json`)))
        .mode & 0o777
    const indexMode =
      (await stat(join(process.env.CORAL_HOME!, 'sessions', 'index.json')))
        .mode & 0o777

    assert.equal(homeMode, 0o700)
    assert.equal(sessionsMode, 0o700)
    assert.equal(sessionMode, 0o600)
    assert.equal(indexMode, 0o600)
  }
)

test('loadSession tolerates legacy session files without local-state fields', async () =>
{
  // simulate a pre-todos/undo session file — no local-state keys on disk
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
  assert.equal(loaded.undo, undefined)
  assert.equal(loaded.redo, undefined)
})

test('loadSession treats objectless JSON session files as missing', async () =>
{
  const dir = join(process.env.CORAL_HOME!, 'sessions')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'nulljson.json'), 'null', 'utf-8')

  const loaded = loadSession('nulljson')

  assert.equal(loaded, undefined)
})

test('session APIs reject path traversal IDs', async () =>
{
  const sessionsDir = join(process.env.CORAL_HOME!, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(
    join(process.env.CORAL_HOME!, 'outside.json'),
    JSON.stringify(makeSession(makeMeta('feedface'))),
    'utf-8'
  )

  assert.equal(loadSession('../outside'), undefined)
  assert.equal(renameSession('../outside', 'bad'), undefined)
  assert.throws(() =>
    saveSession('../outside', 'test-model', '/tmp/test', [
      { role: 'system', content: 'System' },
    ])
  )
})

test('loadSession rejects a session whose messages field is not an array', async () =>
{
  const dir = join(process.env.CORAL_HOME!, 'sessions')
  await mkdir(dir, { recursive: true })
  const malformed = {
    meta: makeMeta('1a2b3c4d'),
    messages: 'not-array',
  }
  await writeFile(join(dir, '1a2b3c4d.json'), JSON.stringify(malformed))

  assert.equal(loadSession('1a2b3c4d'), undefined)
})

test('loadSessionIndex filters invalid index rows and rebuilds from disk', async () =>
{
  const dir = join(process.env.CORAL_HOME!, 'sessions')
  await mkdir(dir, { recursive: true })

  const valid = makeMeta('11112222')
  // valid meta plus a bogus row missing required fields
  const index = {
    version: 1,
    sessions: [valid, { id: '33334444' }],
  }
  await writeFile(join(dir, 'index.json'), JSON.stringify(index))
  // write the matching session file so a rebuild keeps the valid one
  await writeFile(
    join(dir, '11112222.json'),
    JSON.stringify(makeSession(valid))
  )

  const ids = listSessions().map((session) => session.id)

  assert.deepEqual(ids, ['11112222'])
})

test('loadSession and rebuild ignore filename/meta id mismatch', async () =>
{
  const dir = join(process.env.CORAL_HOME!, 'sessions')
  await mkdir(dir, { recursive: true })
  // basename deadbeef but meta.id feedface — both valid hex, mismatched
  await writeFile(
    join(dir, 'deadbeef.json'),
    JSON.stringify(makeSession(makeMeta('feedface')))
  )

  assert.equal(loadSession('feedface'), undefined)
  assert.equal(loadSession('deadbeef'), undefined)

  // force a rebuild from disk — the mismatched session must not appear
  await rm(join(dir, 'index.json'), { force: true })

  assert.equal(
    listSessions().some((session) => session.id === 'feedface'),
    false
  )
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

test('resolveResumeSessionFromCandidates reports missing cwd when required', () =>
{
  const unavailable = makeSessionMeta({
    id: 'abcd1234',
    cwd: '/missing/project',
  })
  const available = makeSessionMeta({ id: 'abce5678', cwd: '/tmp/project' })
  const result = resolveResumeSessionFromCandidates({
    requestedId: unavailable.id,
    requireExistingCwd: true,
    sessions: [unavailable, available],
    loadSessionById: () => undefined,
    canResumeInCwd: (cwd) => cwd === available.cwd,
  })

  assert.equal(result.type, 'unavailable')
  if (result.type === 'unavailable')
  {
    assert.equal(result.session.id, unavailable.id)
  }
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
