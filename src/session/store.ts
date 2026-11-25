// src/session/store.ts
// session persistence and resume

import { existsSync, type BigIntStats } from 'node:fs'
import {
  acquireSessionLease,
  releaseSessionLease,
  withSessionWriteLock,
  type SessionLease,
  type SessionLeaseOwnership,
} from './lease.js'
import { SessionPersistenceError } from './errors.js'
import type { ProcessSessionRuntimeIdentity } from './types.js'
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { OllamaMessage } from '../types/inference.js'
import type { TodoItem } from '../types/todo.js'
import type { UndoTurn } from '../types/undo.js'
import type { SessionCostSnapshot } from '../types/session-cost.js'
import { coralHomePath } from '../utils/coral-home.js'
import { ellipsize } from '../utils/ellipsize.js'
import { ensurePrivateDir } from '../utils/fs.js'
import {
  readJsonObjectFile,
  tryParseJson,
  writeJsonFile,
} from '../utils/json.js'
import {
  decodeSessionData,
  decodeSessionPreview,
  decodeSessionPreviewWithUndo,
  encodeSessionData,
} from './codec.js'
import {
  isValidSessionId,
  type SessionData,
  type SessionMeta,
  type SessionMetaHint,
  type SessionPreviewResult,
} from './types.js'

const SESSION_FILE_PATTERN = /^([0-9a-f]{8})\.json$/
const MAX_CACHED_SESSION_COUNT = 1024
const MAX_CACHED_SESSION_BYTES = 1024 * 1024

interface CachedSessionMeta
{
  meta: Readonly<SessionMeta>
  revision: string
}

interface SessionMetadataCache
{
  dir: string
  generation: number
  entries: Map<string, CachedSessionMeta>
}

let metadataCache: SessionMetadataCache | undefined

// create a short stable session ID
function generateId(): string
{
  return randomBytes(4).toString('hex')
}

function readSessionData(path: string): SessionData | undefined
{
  return decodeSessionData(readJsonObjectFile(path))
}

// same validity and id rule as loadSession without hydrating undo state
function storedSessionExists(id: string): boolean
{
  if (!isValidSessionId(id)) return false
  const preview = decodeSessionPreview(readJsonObjectFile(sessionPath(id)))
  return preview?.meta.id === id
}

// derive the session-list title from the first user message
function extractTitle(messages: OllamaMessage[]): string
{
  const firstUser = messages.find((m) => m.role === 'user')
  if (!firstUser) return '(empty session)'

  const text = (firstUser.displayContent ?? firstUser.content).trim()
  return ellipsize(text, 80)
}

function ensureDir(dir = sessionsDir()): void
{
  ensurePrivateDir(dirname(dir))
  ensurePrivateDir(dir)
}

function sessionsDir(): string
{
  return coralHomePath('sessions')
}

function sessionPath(id: string): string
{
  if (!isValidSessionId(id))
  {
    throw new Error(`Invalid session ID: ${id}`)
  }
  return join(sessionsDir(), `${id}.json`)
}

function cacheForDirectory(dir: string): SessionMetadataCache
{
  if (metadataCache?.dir !== dir)
  {
    metadataCache = { dir, generation: 0, entries: new Map() }
  }
  return metadataCache
}

function fileRevision(path: string, info: BigIntStats): string
{
  return JSON.stringify([
    path,
    ...[info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String),
  ])
}

async function readRevision(
  path: string,
  signal?: AbortSignal
): Promise<string | undefined>
{
  try
  {
    signal?.throwIfAborted()
    const info = await fs.stat(path, { bigint: true })
    signal?.throwIfAborted()
    return info.isFile() ? fileRevision(path, info) : undefined
  }
  catch
  {
    signal?.throwIfAborted()
    return undefined
  }
}

async function readPreview(
  path: string,
  id: string,
  signal?: AbortSignal
): Promise<
  | {
      data: Pick<SessionData, 'meta' | 'messages' | 'undo'>
      revision: string | null
    }
  | undefined
>
{
  try
  {
    signal?.throwIfAborted()
    const file = await fs.open(path, 'r')
    try
    {
      signal?.throwIfAborted()
      const before = fileRevision(path, await file.stat({ bigint: true }))
      const text = await file.readFile({ encoding: 'utf-8', signal })
      signal?.throwIfAborted()
      const after = fileRevision(path, await file.stat({ bigint: true }))
      const current = await readRevision(path, signal)
      signal?.throwIfAborted()
      if (!current) return undefined

      const data = decodeSessionPreviewWithUndo(tryParseJson(text))
      if (!data || data.meta.id !== id) return undefined
      return {
        data,
        revision: before === after && after === current ? current : null,
      }
    }
    finally
    {
      await file.close()
      signal?.throwIfAborted()
    }
  }
  catch
  {
    signal?.throwIfAborted()
    return undefined
  }
}

// retain only public metadata fields, never unknown payloads from the JSON file
function copyMetadata(meta: Readonly<SessionMeta>): SessionMeta
{
  return {
    id: meta.id,
    model: meta.model,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    title: meta.title,
    messageCount: meta.messageCount,
    ...(meta.compactionCount === undefined
      ? {}
      : { compactionCount: meta.compactionCount }),
    ...(meta.lastCompactedAt === undefined
      ? {}
      : { lastCompactedAt: meta.lastCompactedAt }),
  }
}

function countConversationMessages(messages: OllamaMessage[]): number
{
  return messages.filter((m) => m.role !== 'system').length
}

// replace one complete snapshot so concurrent saves keep whole-file semantics
function writeSessionData(session: SessionData): void
{
  withSessionWriteLock(
    undefined,
    () => writeSessionDataUnlocked(session),
    session.meta.id
  )
}

// refuse a snapshot the codec would not load back, so a bad turn fails loudly
// and the previous file stays loadable
function writeSessionDataUnlocked(session: SessionData): void
{
  const encoded = encodeSessionData(session)
  if (!decodeSessionPreview(encoded))
    throw new SessionPersistenceError(
      'invalid_snapshot',
      'Session snapshot would not load back',
      { sessionId: session.meta.id }
    )
  writeEncodedSessionUnlocked(session.meta.id, encoded)
}

// the caller has already encoded and validated the snapshot
function writeEncodedSessionUnlocked(id: string, encoded: object): void
{
  ensureDir()
  const path = sessionPath(id)
  const cache = cacheForDirectory(dirname(path))
  try
  {
    writeJsonFile(path, encoded)
  }
  finally
  {
    cache.entries.delete(path)
    cache.generation++
  }
}

// create and persist a new session
export function createSession(
  model: string,
  cwd: string,
  messages: OllamaMessage[],
  todos: TodoItem[] = [],
  undo: UndoTurn[] = [],
  redo: UndoTurn[] = [],
  title?: string,
  compaction?: Pick<SessionMetaHint, 'compactionCount' | 'lastCompactedAt'>,
  sessionCost?: SessionCostSnapshot
): SessionMeta
{
  ensureDir()

  const now = new Date().toISOString()
  const meta: SessionMeta = {
    id: generateId(),
    model,
    cwd,
    createdAt: now,
    updatedAt: now,
    title: title?.trim() || extractTitle(messages),
    messageCount: countConversationMessages(messages),
    ...(compaction
      ? {
          compactionCount: compaction.compactionCount,
          lastCompactedAt: compaction.lastCompactedAt,
        }
      : {}),
  }

  // ids are 32 random bits, so an id that is already saved or leased by a
  // live session is drawn again rather than replaced
  while (
    !tryCreateSessionFile({ meta, messages, todos, undo, redo, sessionCost })
  )
  {
    meta.id = generateId()
  }
  return meta
}

// write a new session under its id's write lock unless that id is taken
function tryCreateSessionFile(session: SessionData): boolean
{
  try
  {
    return withSessionWriteLock(
      undefined,
      () =>
      {
        if (existsSync(sessionPath(session.meta.id))) return false
        writeSessionDataUnlocked(session)
        return true
      },
      session.meta.id
    )
  }
  catch (error)
  {
    if (
      error instanceof SessionPersistenceError &&
      error.code === 'session_in_use'
    )
      return false
    throw error
  }
}

// save an existing session
export function saveSession(
  id: string,
  model: string,
  cwd: string,
  messages: OllamaMessage[],
  metaHint?: SessionMetaHint,
  todos: TodoItem[] = [],
  undo: UndoTurn[] = [],
  redo: UndoTurn[] = [],
  sessionCost?: SessionCostSnapshot
): SessionMeta
{
  if (!isValidSessionId(id))
  {
    throw new Error(`Invalid session ID: ${id}`)
  }
  ensureDir()

  const now = new Date().toISOString()
  const stored =
    metaHint?.createdAt && metaHint?.title && sessionCost !== undefined
      ? undefined
      : readSessionData(sessionPath(id))
  const storedMeta = stored?.meta
  const meta: SessionMeta = {
    id,
    model,
    cwd,
    createdAt: metaHint?.createdAt ?? storedMeta?.createdAt ?? now,
    updatedAt: now,
    title: metaHint?.title ?? storedMeta?.title ?? extractTitle(messages),
    messageCount: countConversationMessages(messages),
    compactionCount: metaHint?.compactionCount ?? storedMeta?.compactionCount,
    lastCompactedAt: metaHint?.lastCompactedAt ?? storedMeta?.lastCompactedAt,
  }

  writeSessionData({
    meta,
    messages,
    todos,
    undo,
    redo,
    sessionCost: sessionCost ?? stored?.sessionCost,
  })

  return meta
}

// load a session by ID
export function loadSession(id: string): SessionData | undefined
{
  if (!isValidSessionId(id)) return undefined

  const session = readSessionData(sessionPath(id))
  if (!session) return undefined
  if (session.meta.id !== id) return undefined
  return session
}

// list sessions newest first
export async function listSessions({
  signal,
}: { signal?: AbortSignal } = {}): Promise<SessionMeta[]>
{
  signal?.throwIfAborted()
  const dir = sessionsDir()
  ensureDir(dir)
  const cache = cacheForDirectory(dir)
  const generation = cache.generation
  const files = await fs.readdir(dir)
  signal?.throwIfAborted()
  const sessions: {
    path: string
    meta: SessionMeta
    revision: string | null
  }[] = []

  // discovery and stat checks remain authoritative; only unchanged bodies are reused
  for (const file of files)
  {
    signal?.throwIfAborted()
    const match = SESSION_FILE_PATTERN.exec(file)
    if (!match) continue
    const path = join(dir, file)
    const revision = await readRevision(path, signal)
    if (!revision) continue
    const cached = cache.entries.get(path)
    if (cached?.revision === revision)
    {
      sessions.push({ path, meta: copyMetadata(cached.meta), revision })
      continue
    }

    const preview = await readPreview(path, match[1]!, signal)
    if (preview)
    {
      sessions.push({
        path,
        meta: copyMetadata(preview.data.meta),
        revision: preview.revision,
      })
    }
  }

  sessions.sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt))
  signal?.throwIfAborted()
  if (metadataCache === cache && cache.generation === generation)
  {
    const entries = new Map<string, CachedSessionMeta>()
    let bytes = 0
    for (const session of sessions)
    {
      if (entries.size === MAX_CACHED_SESSION_COUNT) break
      if (session.revision === null) continue
      const entry = {
        meta: Object.freeze(copyMetadata(session.meta)),
        revision: session.revision,
      }
      const size = Buffer.byteLength(JSON.stringify([session.path, entry]))
      if (bytes + size > MAX_CACHED_SESSION_BYTES) continue
      entries.set(session.path, entry)
      bytes += size
    }
    cache.entries = entries
  }

  return sessions.map((session) => session.meta)
}

// callers retain display tails; the store retains no message or undo payloads
export async function loadSessionPreview(
  id: string,
  {
    knownRevision,
    signal,
  }: { knownRevision?: string; signal?: AbortSignal } = {}
): Promise<SessionPreviewResult>
{
  signal?.throwIfAborted()
  if (!isValidSessionId(id)) return { kind: 'missing' }
  const path = join(sessionsDir(), `${id}.json`)
  const revision = await readRevision(path, signal)
  if (!revision) return { kind: 'missing' }
  if (revision === knownRevision) return { kind: 'unchanged', revision }
  const preview = await readPreview(path, id, signal)
  return preview
    ? {
        kind: 'loaded',
        revision: preview.revision,
        messages: preview.data.messages,
        undo: preview.data.undo,
      }
    : { kind: 'missing' }
}

// heuristic title a fresh untitled session receives; exposed so callers can
// distinguish fallback titles from explicit renames without duplicating policy
export function derivedSessionTitle(messages: OllamaMessage[]): string
{
  return extractTitle(messages)
}

// rename a session title
export function renameSession(
  id: string,
  title: string
): SessionMeta | undefined
{
  if (!isValidSessionId(id)) return undefined

  const session = readSessionData(sessionPath(id))
  if (!session) return undefined

  session.meta.title = title
  session.meta.updatedAt = new Date().toISOString()

  writeSessionData(session)

  return session.meta
}

export interface ProviderSessionSaveInput
{
  sessionId: string
  lease: SessionLeaseOwnership
  snapshot: SessionData
}

export interface ProviderSessionMetadataSaveInput
{
  sessionId: string
  lease: SessionLeaseOwnership
  runtime: ProcessSessionRuntimeIdentity
  model: string
  cwd: string
  metaHint: SessionMetaHint
}

// acquire ownership before publishing a new native snapshot
export function createProviderSession(input: {
  model: string
  cwd: string
  runtime: ProcessSessionRuntimeIdentity
}): { session: SessionData; lease: SessionLease }
{
  const id = generateId()
  const lease = acquireSessionLease(id, input.runtime)
  try
  {
    const now = new Date().toISOString()
    const session: SessionData = {
      meta: {
        id,
        model: input.model,
        cwd: input.cwd,
        createdAt: now,
        updatedAt: now,
        title: '(empty session)',
        messageCount: 0,
      },
      messages: [],
      todos: [],
      undo: [],
      redo: [],
    }
    withSessionWriteLock(lease, () =>
    {
      if (existsSync(sessionPath(id)))
        throw new SessionPersistenceError(
          'create_failed',
          'Session ID already exists',
          { sessionId: id }
        )
      writeSessionDataUnlocked(session)
    })
    return { session, lease }
  }
  catch (error)
  {
    releaseSessionLease(lease)
    throw error
  }
}

// retries write the same captured whole snapshot under the same exclusive lease
export function saveProviderSession(
  input: ProviderSessionSaveInput
): SessionData
{
  if (
    input.sessionId !== input.snapshot.meta.id ||
    input.sessionId !== input.lease.sessionId
  )
  {
    throw new SessionPersistenceError(
      'invalid_snapshot',
      'Snapshot does not match its leased session'
    )
  }
  const encoded = encodeSessionData(input.snapshot)
  if (!decodeSessionPreview(encoded))
    throw new SessionPersistenceError(
      'invalid_snapshot',
      'Invalid provider snapshot'
    )
  withSessionWriteLock(input.lease, () =>
  {
    if (!storedSessionExists(input.sessionId))
      throw new SessionPersistenceError(
        'session_not_found',
        'Session disappeared before save'
      )
    writeEncodedSessionUnlocked(input.sessionId, encoded)
  })
  return input.snapshot
}

export const retryProviderSessionSave = saveProviderSession

export function saveProviderSessionMetadata(
  input: ProviderSessionMetadataSaveInput
): SessionData
{
  if (input.sessionId !== input.lease.sessionId)
    throw new SessionPersistenceError(
      'lease_not_owned',
      'Metadata does not match its lease'
    )
  return withSessionWriteLock(input.lease, () =>
  {
    const session = loadSession(input.sessionId)
    if (!session)
      throw new SessionPersistenceError(
        'session_not_found',
        'Session disappeared before metadata save'
      )
    const saved = {
      ...session,
      meta: {
        ...session.meta,
        ...input.metaHint,
        model: input.model,
        cwd: input.cwd,
        updatedAt: new Date().toISOString(),
      },
    }
    writeSessionDataUnlocked(saved)
    return saved
  })
}
