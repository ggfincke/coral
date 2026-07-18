// src/session/store.ts
// session persistence and resume

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { OllamaMessage } from '../types/inference.js'
import type { TodoItem } from '../types/todo.js'
import type { UndoTurn } from '../types/undo.js'
import { coralHomePath } from '../utils/coral-home.js'
import { ellipsize } from '../utils/ellipsize.js'
import { ensurePrivateDir } from '../utils/fs.js'
import { readJsonObjectFile, writeJsonFile } from '../utils/json.js'
import { decodeSessionData, encodeSessionData } from './codec.js'
import {
  isValidSessionId,
  type SessionData,
  type SessionMeta,
  type SessionMetaHint,
} from './types.js'

const SESSION_FILE_PATTERN = /^([0-9a-f]{8})\.json$/

// create a short stable session ID
function generateId(): string
{
  return randomBytes(4).toString('hex')
}

function readSessionData(path: string): SessionData | undefined
{
  return decodeSessionData(readJsonObjectFile(path))
}

// derive the session-list title from the first user message
function extractTitle(messages: OllamaMessage[]): string
{
  const firstUser = messages.find((m) => m.role === 'user')
  if (!firstUser) return '(empty session)'

  const text = (firstUser.displayContent ?? firstUser.content).trim()
  return ellipsize(text, 80)
}

function ensureDir(): void
{
  ensurePrivateDir(coralHomePath())
  ensurePrivateDir(sessionsDir())
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

function sortSessions(sessions: SessionMeta[]): SessionMeta[]
{
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// discover sessions from authoritative files so a stale legacy index cannot hide them
function discoverSessions(): SessionMeta[]
{
  ensureDir()

  const sessions: SessionMeta[] = []
  const dir = sessionsDir()
  const files = readdirSync(dir)

  for (const file of files)
  {
    const match = SESSION_FILE_PATTERN.exec(file)
    if (!match) continue
    const id = match[1]!

    const session = readSessionData(join(dir, file))
    if (session && session.meta.id === id)
    {
      sessions.push(session.meta)
    }
  }

  return sortSessions(sessions)
}

function countConversationMessages(messages: OllamaMessage[]): number
{
  return messages.filter((m) => m.role !== 'system').length
}

// replace one complete snapshot so concurrent saves keep whole-file semantics
function writeSessionData(session: SessionData): void
{
  ensureDir()
  writeJsonFile(sessionPath(session.meta.id), encodeSessionData(session))
}

// create and persist a new session
export function createSession(
  model: string,
  cwd: string,
  messages: OllamaMessage[],
  todos: TodoItem[] = [],
  undo: UndoTurn[] = [],
  redo: UndoTurn[] = []
): SessionMeta
{
  ensureDir()

  const id = generateId()
  const now = new Date().toISOString()
  const meta: SessionMeta = {
    id,
    model,
    cwd,
    createdAt: now,
    updatedAt: now,
    title: extractTitle(messages),
    messageCount: countConversationMessages(messages),
  }

  writeSessionData({ meta, messages, todos, undo, redo })

  return meta
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
  redo: UndoTurn[] = []
): SessionMeta
{
  if (!isValidSessionId(id))
  {
    throw new Error(`Invalid session ID: ${id}`)
  }
  ensureDir()

  const now = new Date().toISOString()
  const storedMeta =
    metaHint?.createdAt && metaHint?.title
      ? undefined
      : readSessionData(sessionPath(id))?.meta
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

  writeSessionData({ meta, messages, todos, undo, redo })

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
export function listSessions(): SessionMeta[]
{
  return discoverSessions()
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
