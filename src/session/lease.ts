// src/session/lease.ts
// exclusive owner-token leases for provider session runtimes

import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { hostname } from 'node:os'
import Database from 'better-sqlite3'
import { coralHomePath } from '../utils/coral-home.js'
import { ensurePrivateDir } from '../utils/fs.js'
import {
  isRecordedProcessGone,
  ownProcessStartTime,
} from '../utils/process-identity.js'
import { SessionPersistenceError } from './errors.js'
import {
  isValidSessionId,
  type ProcessSessionRuntimeIdentity,
} from './types.js'

const LEASE_SCHEMA_VERSION = 1
let processStartedAtValue: string | undefined

interface LeaseRow
{
  session_id: string
  owner_token: string
  runtime_id: string
  hostname: string
  process_id: number
  process_started_at: string
  acquired_at: string
}

export interface SessionLeaseOwnership
{
  sessionId: string
  ownerToken: string
  runtimeId: string
}

export interface SessionLease extends SessionLeaseOwnership
{
  runtime: ProcessSessionRuntimeIdentity
  acquiredAt: string
  release(): Promise<void>
}

function leasesPath(): string
{
  return coralHomePath('sessions', 'leases.sqlite')
}

function openLeaseDatabase(): Database.Database
{
  ensurePrivateDir(coralHomePath())
  ensurePrivateDir(coralHomePath('sessions'))

  const path = leasesPath()
  const database = new Database(path)
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  database.pragma('busy_timeout = 2000')
  database.pragma('journal_mode = DELETE')
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_leases (
      session_id TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL UNIQUE,
      runtime_id TEXT NOT NULL,
      hostname TEXT NOT NULL,
      process_id INTEGER NOT NULL,
      process_started_at TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL
        CHECK (schema_version = ${LEASE_SCHEMA_VERSION})
    )
  `)
  return database
}

// the start time other runtimes compare against to detect pid reuse; the
// uptime estimate fallback is never a known start time, so it reads as unknown
function processStartedAt(): string
{
  processStartedAtValue ??=
    ownProcessStartTime() ??
    new Date(Date.now() - process.uptime() * 1_000).toISOString()
  return processStartedAtValue
}

function isNonEmptyBoundedString(value: string): boolean
{
  return value.length > 0 && value.length <= 256
}

function assertRuntimeIdentity(runtime: ProcessSessionRuntimeIdentity): void
{
  if (
    runtime.kind !== 'process' ||
    !isNonEmptyBoundedString(runtime.runtimeId) ||
    !isNonEmptyBoundedString(runtime.hostname) ||
    !Number.isSafeInteger(runtime.processId) ||
    runtime.processId <= 0 ||
    !isNonEmptyBoundedString(runtime.processStartedAt)
  )
  {
    throw new SessionPersistenceError(
      'invalid_session',
      'Session runtime identity is invalid'
    )
  }
  if (
    runtime.hostname !== hostname() ||
    runtime.processId !== process.pid ||
    runtime.processStartedAt !== processStartedAt()
  )
  {
    throw new SessionPersistenceError(
      'invalid_session',
      'Session runtime identity does not describe this process'
    )
  }
}

// only a conclusively gone process on this host is recoverable: its pid is
// absent, or now runs a process whose known start time differs from the record
function isConservativelyStale(row: LeaseRow): boolean
{
  if (row.hostname !== hostname()) return false
  if (!Number.isSafeInteger(row.process_id) || row.process_id <= 0) return false
  if (!isNonEmptyBoundedString(row.runtime_id)) return false
  if (!isNonEmptyBoundedString(row.process_started_at)) return false
  return isRecordedProcessGone(row.process_id, row.process_started_at)
}

function leaseRow(
  database: Database.Database,
  sessionId: string
): LeaseRow | undefined
{
  return database
    .prepare(
      `SELECT session_id, owner_token, runtime_id, hostname, process_id,
              process_started_at, acquired_at
         FROM session_leases
        WHERE session_id = ?`
    )
    .get(sessionId) as LeaseRow | undefined
}

// drop a recoverable lease inside the caller's transaction; a live owner refuses
function clearRecoverableLease(
  database: Database.Database,
  sessionId: string
): void
{
  const row = leaseRow(database, sessionId)
  if (!row) return
  if (!isConservativelyStale(row))
  {
    throw new SessionPersistenceError(
      'session_in_use',
      `Session ${sessionId} is already in use`,
      { sessionId }
    )
  }
  const deleted = database
    .prepare(
      'DELETE FROM session_leases WHERE session_id = ? AND owner_token = ?'
    )
    .run(sessionId, row.owner_token)
  if (deleted.changes !== 1)
  {
    throw new SessionPersistenceError(
      'session_in_use',
      `Session ${sessionId} lease changed during recovery`,
      { sessionId }
    )
  }
}

function deleteOwnedLease(sessionId: string, ownerToken: string): boolean
{
  try
  {
    const database = openLeaseDatabase()
    try
    {
      const result = database
        .prepare(
          'DELETE FROM session_leases WHERE session_id = ? AND owner_token = ?'
        )
        .run(sessionId, ownerToken)
      return result.changes === 1
    }
    finally
    {
      database.close()
    }
  }
  catch (error)
  {
    if (error instanceof SessionPersistenceError) throw error
    throw new SessionPersistenceError(
      'lease_failed',
      `Could not release session ${sessionId} lease`,
      { sessionId, cause: error }
    )
  }
}

class OwnedSessionLease implements SessionLease
{
  private releasePromise?: Promise<void>

  constructor(
    readonly sessionId: string,
    readonly ownerToken: string,
    readonly runtime: ProcessSessionRuntimeIdentity,
    readonly acquiredAt: string
  )
  {}

  get runtimeId(): string
  {
    return this.runtime.runtimeId
  }

  release(): Promise<void>
  {
    if (this.releasePromise) return this.releasePromise

    const releasePromise = Promise.resolve().then(() =>
    {
      deleteOwnedLease(this.sessionId, this.ownerToken)
    })
    this.releasePromise = releasePromise
    void releasePromise.catch(() =>
    {
      if (this.releasePromise === releasePromise)
      {
        this.releasePromise = undefined
      }
    })
    return releasePromise
  }
}

export function createSessionRuntimeIdentity(
  runtimeId = randomUUID()
): ProcessSessionRuntimeIdentity
{
  return {
    kind: 'process',
    runtimeId,
    hostname: hostname(),
    processId: process.pid,
    processStartedAt: processStartedAt(),
  }
}

export function acquireSessionLease(
  sessionId: string,
  runtime: ProcessSessionRuntimeIdentity
): SessionLease
{
  if (!isValidSessionId(sessionId))
  {
    throw new SessionPersistenceError('invalid_session', 'Invalid session ID', {
      sessionId,
    })
  }
  assertRuntimeIdentity(runtime)

  const ownerToken = randomUUID()
  const acquiredAt = new Date().toISOString()

  try
  {
    const database = openLeaseDatabase()
    try
    {
      const acquire = database.transaction(() =>
      {
        clearRecoverableLease(database, sessionId)
        database
          .prepare(
            `INSERT INTO session_leases (
             session_id, owner_token, runtime_id, hostname, process_id,
             process_started_at, acquired_at, schema_version
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            sessionId,
            ownerToken,
            runtime.runtimeId,
            runtime.hostname,
            runtime.processId,
            runtime.processStartedAt,
            acquiredAt,
            LEASE_SCHEMA_VERSION
          )
      })
      acquire.immediate()
    }
    finally
    {
      database.close()
    }
  }
  catch (error)
  {
    if (error instanceof SessionPersistenceError) throw error
    throw new SessionPersistenceError(
      'lease_failed',
      `Could not acquire session ${sessionId} lease`,
      { sessionId, cause: error }
    )
  }

  return new OwnedSessionLease(sessionId, ownerToken, runtime, acquiredAt)
}

export function verifySessionLeaseOwnership(
  ownership: SessionLeaseOwnership
): boolean
{
  if (!isValidSessionId(ownership.sessionId)) return false
  if (!isNonEmptyBoundedString(ownership.ownerToken)) return false
  if (!isNonEmptyBoundedString(ownership.runtimeId)) return false

  const database = openLeaseDatabase()
  try
  {
    const row = leaseRow(database, ownership.sessionId)
    return (
      row?.owner_token === ownership.ownerToken &&
      row.runtime_id === ownership.runtimeId
    )
  }
  finally
  {
    database.close()
  }
}

// serialize revision read/replace cycles with lease acquisition and release
export function withSessionWriteLock<T>(
  ownership: SessionLeaseOwnership | undefined,
  action: () => T,
  refuseLeaseForSessionId?: string
): T
{
  try
  {
    const database = openLeaseDatabase()
    try
    {
      const run = database.transaction(() =>
      {
        if (ownership)
        {
          const row = leaseRow(database, ownership.sessionId)
          if (
            row?.owner_token !== ownership.ownerToken ||
            row.runtime_id !== ownership.runtimeId
          )
          {
            throw new SessionPersistenceError(
              'lease_not_owned',
              `Provider does not own session ${ownership.sessionId}`,
              { sessionId: ownership.sessionId }
            )
          }
        }
        else if (refuseLeaseForSessionId)
        {
          clearRecoverableLease(database, refuseLeaseForSessionId)
        }
        return action()
      })
      return run.immediate()
    }
    finally
    {
      database.close()
    }
  }
  catch (error)
  {
    if (error instanceof SessionPersistenceError) throw error
    throw new SessionPersistenceError(
      'lease_failed',
      'Could not lock session persistence',
      { sessionId: ownership?.sessionId, cause: error }
    )
  }
}

// expose token-safe release for shutdown recovery and focused ownership tests
export function releaseSessionLease(ownership: SessionLeaseOwnership): boolean
{
  if (!isValidSessionId(ownership.sessionId)) return false
  if (!isNonEmptyBoundedString(ownership.ownerToken)) return false
  return deleteOwnedLease(ownership.sessionId, ownership.ownerToken)
}
