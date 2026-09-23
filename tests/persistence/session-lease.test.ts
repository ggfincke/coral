// tests/persistence/session-lease.test.ts
// provider save recovery and exclusive session lease contracts

import { strict as assert } from 'node:assert'
import { stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import Database from 'better-sqlite3'
import { SessionPersistenceError } from '../../src/session/errors.js'
import {
  acquireSessionLease,
  createSessionRuntimeIdentity,
  verifySessionLeaseOwnership,
} from '../../src/session/lease.js'
import {
  loadSession,
  retryProviderSessionSave,
  saveProviderSession,
} from '../../src/session/store.js'
import type { SessionPersistenceErrorCode } from '../../src/session/errors.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()

beforeEach(async () =>
{
  process.env.CORAL_HOME = await tempDir('coral-session-lease-')
})

after(async () =>
{
  restoreCoralHome()
  await cleanup()
})

function assertPersistenceError(
  action: () => unknown,
  code: SessionPersistenceErrorCode
): void
{
  assert.throws(action, (error: unknown) =>
  {
    assert.ok(error instanceof SessionPersistenceError)
    assert.equal(error.code, code)
    return true
  })
}

test('ordinary native saves and renames respect provider ownership without changing legacy snapshots', async () =>
{
  const { createSession, saveSession, renameSession } =
    await import('../../src/session/store.js')
  const meta = createSession('model-a', '/workspace', [
    { role: 'user', content: 'legacy' },
  ])
  const before = loadSession(meta.id)!
  const lease = acquireSessionLease(meta.id, createSessionRuntimeIdentity())
  assertPersistenceError(
    () => saveSession(meta.id, 'model-a', '/workspace', []),
    'session_in_use'
  )
  assertPersistenceError(
    () => renameSession(meta.id, 'raced title'),
    'session_in_use'
  )
  const snapshot = structuredClone(before)
  snapshot.messages.push({ role: 'assistant', content: 'saved response' })
  snapshot.meta.messageCount = 2
  const input = { sessionId: meta.id, lease, snapshot }
  saveProviderSession(input)
  retryProviderSessionSave(input)
  assert.deepEqual(loadSession(meta.id)?.messages, snapshot.messages)
  await lease.release()
  renameSession(meta.id, 'renamed after release')
  assert.equal(loadSession(meta.id)?.meta.title, 'renamed after release')
})

test('a transient lease release lock failure can be retried and stays joined', async () =>
{
  const lease = acquireSessionLease(
    'acceded0',
    createSessionRuntimeIdentity('release-retry-runtime')
  )
  const database = new Database(
    join(process.env.CORAL_HOME!, 'sessions', 'leases.sqlite')
  )
  database.exec('BEGIN EXCLUSIVE')

  const failedRelease = lease.release()
  assert.equal(lease.release(), failedRelease)
  try
  {
    await assert.rejects(failedRelease, (error: unknown) =>
    {
      assert.ok(error instanceof SessionPersistenceError)
      assert.equal(error.code, 'lease_failed')
      return true
    })
  }
  finally
  {
    database.exec('ROLLBACK')
    database.close()
  }

  assert.equal(verifySessionLeaseOwnership(lease), true)
  const retriedRelease = lease.release()
  assert.notEqual(retriedRelease, failedRelease)
  assert.equal(lease.release(), retriedRelease)
  await retriedRelease
  assert.equal(verifySessionLeaseOwnership(lease), false)
  assert.equal(lease.release(), retriedRelease)
})

test('leases refuse active owners and recover only a conclusively dead process', async () =>
{
  const sessionId = 'feedface'
  const runtime = createSessionRuntimeIdentity('lease-owner-a')
  const first = acquireSessionLease(sessionId, runtime)

  assert.equal(verifySessionLeaseOwnership(first), true)
  assertPersistenceError(
    () =>
      acquireSessionLease(
        sessionId,
        createSessionRuntimeIdentity('lease-contender')
      ),
    'session_in_use'
  )

  const databasePath = join(
    process.env.CORAL_HOME!,
    'sessions',
    'leases.sqlite'
  )
  const database = new Database(databasePath)
  try
  {
    database
      .prepare(
        `UPDATE session_leases
            SET process_id = ?, hostname = ?
          WHERE session_id = ? AND owner_token = ?`
      )
      .run(
        2_147_483_647,
        'foreign-runtime.example',
        sessionId,
        first.ownerToken
      )
  }
  finally
  {
    database.close()
  }
  assertPersistenceError(
    () =>
      acquireSessionLease(
        sessionId,
        createSessionRuntimeIdentity('lease-foreign-contender')
      ),
    'session_in_use'
  )

  const staleDatabase = new Database(databasePath)
  try
  {
    staleDatabase
      .prepare(
        `UPDATE session_leases
            SET process_id = ?, hostname = ?
          WHERE session_id = ? AND owner_token = ?`
      )
      .run(2_147_483_647, hostname(), sessionId, first.ownerToken)
  }
  finally
  {
    staleDatabase.close()
  }

  const second = acquireSessionLease(
    sessionId,
    createSessionRuntimeIdentity('lease-owner-b')
  )
  assert.equal(verifySessionLeaseOwnership(second), true)

  const firstRelease = first.release()
  assert.equal(first.release(), firstRelease)
  await firstRelease
  assert.equal(verifySessionLeaseOwnership(second), true)
  assertPersistenceError(
    () =>
      acquireSessionLease(
        sessionId,
        createSessionRuntimeIdentity('lease-contender-after-stale')
      ),
    'session_in_use'
  )

  const secondRelease = second.release()
  assert.equal(second.release(), secondRelease)
  await secondRelease
  const third = acquireSessionLease(
    sessionId,
    createSessionRuntimeIdentity('lease-owner-c')
  )
  assert.equal(verifySessionLeaseOwnership(third), true)
  await third.release()

  if (process.platform !== 'win32')
  {
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600)
    assert.equal(
      (await stat(join(process.env.CORAL_HOME!, 'sessions'))).mode & 0o777,
      0o700
    )
  }
})
