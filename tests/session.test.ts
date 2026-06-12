// tests/session.test.ts
// tests for session persistence

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import type { OllamaMessage } from '../src/types/inference.js'
import {
  createSession,
  saveSession,
  loadSession,
  listSessions,
  renameSession,
} from '../src/session/store.js'

const tempDirs: string[] = []
const originalCoralHome = process.env.CORAL_HOME

beforeEach(async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-sessions-'))
  tempDirs.push(dir)
  process.env.CORAL_HOME = dir
})

after(async () =>
{
  if (originalCoralHome === undefined)
  {
    delete process.env.CORAL_HOME
  }
  else
  {
    process.env.CORAL_HOME = originalCoralHome
  }

  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
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
