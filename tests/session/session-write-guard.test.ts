// tests/session/session-write-guard.test.ts
// new-session id collisions and unloadable snapshots never replace a saved session

import { strict as assert } from 'node:assert'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SessionPersistenceError } from '../../src/session/errors.js'
import {
  createSession,
  listSessions,
  loadSession,
  saveSession,
} from '../../src/session/store.js'
import type { OllamaMessage } from '../../src/types/inference.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()
const restoreCoralHome = captureCoralHome()
after(restoreCoralHome)

const MESSAGES: OllamaMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'first turn' },
  { role: 'assistant', content: 'answer' },
]

test('createSession draws a new id instead of replacing an existing session', async (t) =>
{
  process.env.CORAL_HOME = await tempDir('coral-session-collision-')
  const existing = createSession('fake', '/tmp', MESSAGES)
  const path = join(process.env.CORAL_HOME, 'sessions', `${existing.id}.json`)
  const before = await readFile(path, 'utf-8')

  const randomBytes = crypto.randomBytes
  let calls = 0
  t.mock.method(crypto, 'randomBytes', (size: number) =>
    calls++ === 0 ? Buffer.from(existing.id, 'hex') : randomBytes(size)
  )
  syncBuiltinESMExports()
  let created
  try
  {
    created = createSession('other', '/tmp', [
      { role: 'user', content: 'second session' },
    ])
  }
  finally
  {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }

  assert.equal(calls, 2)
  assert.notEqual(created.id, existing.id)
  assert.equal(await readFile(path, 'utf-8'), before)
  assert.equal(loadSession(created.id)?.meta.model, 'other')
})

test('a save the codec would refuse throws and keeps the previous snapshot', async () =>
{
  process.env.CORAL_HOME = await tempDir('coral-session-unloadable-')
  const meta = createSession('fake', '/tmp', MESSAGES)
  const bad = [
    ...MESSAGES,
    { role: 'user', content: 'second turn' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          type: 'function',
          function: { name: 'read_file', arguments: ['a.txt'] as never },
        },
      ],
    },
  ] as OllamaMessage[]

  assert.throws(
    () =>
      saveSession(meta.id, 'fake', '/tmp', bad, {
        createdAt: meta.createdAt,
        title: meta.title,
      }),
    (error) =>
      error instanceof SessionPersistenceError &&
      error.code === 'invalid_snapshot'
  )
  assert.equal(loadSession(meta.id)?.messages.length, MESSAGES.length)
  assert.equal((await listSessions()).length, 1)
})
