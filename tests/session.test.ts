// tests/session.test.ts
// tests for session persistence (save/load/list/resume)

import { strict as assert } from 'node:assert'
import { rm } from 'node:fs/promises'
import { after, test } from 'node:test'
import type { OllamaMessage } from '../src/ollama/client.js'

// override SESSIONS_DIR before importing store — use a temp directory
// we need to monkey-patch the module's internal path

const tempDirs: string[] = []

after(async () =>
{
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

// import the store functions (they use ~/.coral/sessions by default)
// tests create actual sessions in the real dir — we'll clean up by ID
import {
  createSession,
  saveSession,
  loadSession,
  listSessions,
  getLatestSession,
  sessionExists,
  renameSession,
} from '../src/session/store.js'

test('createSession creates a session & returns metadata', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'You are Coral.' },
    { role: 'user', content: 'Hello, Coral!' },
    { role: 'assistant', content: 'Hi! How can I help?' },
  ]

  const meta = createSession('test-model', '/tmp/test-project', messages)

  assert.ok(meta.id)
  assert.equal(meta.id.length, 8)
  assert.equal(meta.model, 'test-model')
  assert.equal(meta.cwd, '/tmp/test-project')
  assert.equal(meta.title, 'Hello, Coral!')
  assert.equal(meta.messageCount, 2)
  assert.ok(meta.createdAt)
  assert.ok(meta.updatedAt)
})

test('loadSession returns saved messages', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'What files are here?' },
    { role: 'assistant', content: 'Let me check.' },
    { role: 'tool', tool_name: 'list_files', content: 'src/\npackage.json' },
    { role: 'assistant', content: 'I see src/ and package.json.' },
  ]

  const meta = createSession('test-model', '/tmp/test', messages)
  const loaded = loadSession(meta.id)

  assert.ok(loaded)
  assert.equal(loaded.messages.length, 5)
  assert.equal(loaded.meta.id, meta.id)
  assert.equal(loaded.meta.messageCount, 4)
  assert.equal(loaded.messages[0]!.role, 'system')
  assert.equal(loaded.messages[1]!.content, 'What files are here?')
  assert.equal(loaded.messages[3]!.tool_name, 'list_files')
})

test('saveSession updates an existing session', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'First message' },
    { role: 'assistant', content: 'Response' },
  ]

  const meta = createSession('test-model', '/tmp/test', messages)
  const originalCreatedAt = meta.createdAt

  // add more messages & save
  messages.push({ role: 'user', content: 'Second message' })
  messages.push({ role: 'assistant', content: 'Second response' })

  const updated = saveSession(meta.id, 'test-model', '/tmp/test', messages)

  assert.equal(updated.id, meta.id)
  assert.equal(updated.createdAt, originalCreatedAt)
  assert.equal(updated.messageCount, 4)
  assert.equal(updated.title, 'First message')

  const loaded = loadSession(meta.id)
  assert.ok(loaded)
  assert.equal(loaded.messages.length, 5)
})

test('loadSession returns null for nonexistent session', () =>
{
  const loaded = loadSession('nonexistent_id_123')
  assert.equal(loaded, null)
})

test('sessionExists returns correct boolean', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Test' },
  ]

  const meta = createSession('test-model', '/tmp/test', messages)

  assert.equal(sessionExists(meta.id), true)
  assert.equal(sessionExists('nonexistent_abcdef'), false)
})

test('listSessions returns sessions sorted by updatedAt descending', async () =>
{
  const messages1: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Session one' },
  ]
  const meta1 = createSession('model-a', '/tmp/a', messages1)

  // small delay to ensure different timestamps
  await new Promise((resolve) => setTimeout(resolve, 10))

  const messages2: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Session two' },
  ]
  const meta2 = createSession('model-b', '/tmp/b', messages2)

  const sessions = listSessions()

  // newest should be first
  const ids = sessions.map((s) => s.id)
  const idx1 = ids.indexOf(meta1.id)
  const idx2 = ids.indexOf(meta2.id)

  assert.ok(idx1 >= 0, 'session 1 should be in the list')
  assert.ok(idx2 >= 0, 'session 2 should be in the list')
  assert.ok(idx2 < idx1, 'newer session should appear first')
})

test('getLatestSession returns the most recently updated session', async () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Latest session test' },
  ]

  const meta = createSession('test-model', '/tmp/latest', messages)

  const latest = getLatestSession()
  assert.ok(latest)
  // latest should be the one we just created (or more recent)
  assert.ok(latest.updatedAt >= meta.updatedAt)
})

test('session title is extracted from first user message', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'assistant', content: 'Welcome!' },
    { role: 'user', content: 'Fix the login bug in auth.ts' },
    { role: 'assistant', content: "I'll look into it." },
  ]

  const meta = createSession('test-model', '/tmp/test', messages)
  assert.equal(meta.title, 'Fix the login bug in auth.ts')
})

test('session title truncates long first messages', () =>
{
  const longMessage = 'a'.repeat(200)
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: longMessage },
  ]

  const meta = createSession('test-model', '/tmp/test', messages)
  assert.ok(meta.title.length <= 80)
  assert.match(meta.title, /…$/)
})

test('session with no user messages gets default title', () =>
{
  const messages: OllamaMessage[] = [{ role: 'system', content: 'System' }]

  const meta = createSession('test-model', '/tmp/test', messages)
  assert.equal(meta.title, '(empty session)')
})

test('renameSession updates title and updatedAt', async () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Original title' },
  ]

  const meta = createSession('test-model', '/tmp/test', messages)
  const originalUpdatedAt = meta.updatedAt

  // small delay to ensure different timestamp
  await new Promise((resolve) => setTimeout(resolve, 10))

  const renamed = renameSession(meta.id, 'New title')

  assert.ok(renamed)
  assert.equal(renamed.id, meta.id)
  assert.equal(renamed.title, 'New title')
  assert.equal(renamed.createdAt, meta.createdAt)
  assert.ok(renamed.updatedAt > originalUpdatedAt)
})

test('renameSession returns null for nonexistent session', () =>
{
  const result = renameSession('nonexistent_abcdef', 'New title')
  assert.equal(result, null)
})

test('renameSession updates the session index', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Index test' },
  ]

  const meta = createSession('test-model', '/tmp/test', messages)
  renameSession(meta.id, 'Renamed in index')

  const sessions = listSessions()
  const found = sessions.find((s) => s.id === meta.id)

  assert.ok(found)
  assert.equal(found.title, 'Renamed in index')
})

test('renameSession preserves other metadata fields', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Preserve test' },
    { role: 'assistant', content: 'Response' },
  ]

  const meta = createSession('test-model', '/tmp/preserve', messages)
  const renamed = renameSession(meta.id, 'New name')

  assert.ok(renamed)
  assert.equal(renamed.model, 'test-model')
  assert.equal(renamed.cwd, '/tmp/preserve')
  assert.equal(renamed.messageCount, 2)
  assert.equal(renamed.createdAt, meta.createdAt)

  // verify full session data is intact
  const loaded = loadSession(meta.id)
  assert.ok(loaded)
  assert.equal(loaded.messages.length, 3)
  assert.equal(loaded.meta.title, 'New name')
})
