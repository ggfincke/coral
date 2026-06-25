// src/session/store.ts
// session persistence — save & resume conversations to/from disk

import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { OllamaMessage } from '../types/inference.js'
import type { TodoItem } from '../tools/todo-store.js'
import { coralHomePath } from '../utils/coral-home.js'
import { ellipsize } from '../utils/ellipsize.js'
import { readJsonObjectFile, writeJsonFile } from '../utils/json.js'

// ! keep in sync w/ scripts/lib/coral_dev_tools/session_analysis.py SESSION_INDEX_VERSION
const SESSION_INDEX_VERSION = 1

// session metadata stored alongside the conversation
export interface SessionMeta
{
  // unique session ID (8-char hex)
  id: string
  // model used for the session
  model: string
  // absolute working directory at session start
  cwd: string
  // ISO timestamp of session creation
  createdAt: string
  // ISO timestamp of last update
  updatedAt: string
  // first user message (for display in session list)
  title: string
  // total number of messages (excluding system prompt)
  messageCount: number
  // number of compaction events during this session
  compactionCount?: number
  // ISO timestamp of the last successful compaction
  lastCompactedAt?: string
}

// cached metadata passed back into saveSession to avoid disk reads
export interface SessionMetaHint
{
  createdAt?: string
  title?: string
  compactionCount?: number
  lastCompactedAt?: string
}

// full session on disk
export interface SessionData
{
  meta: SessionMeta
  messages: OllamaMessage[]
  // task list snapshot so /resume restores the todo panel
  todos?: TodoItem[]
}

interface SessionIndexFile
{
  version: number
  sessions: SessionMeta[]
}

// generate an 8-char hex session ID
function generateId(): string
{
  return randomBytes(4).toString('hex')
}

// extract a title from the first user message
function extractTitle(messages: OllamaMessage[]): string
{
  const firstUser = messages.find((m) => m.role === 'user')
  if (!firstUser) return '(empty session)'

  const text = firstUser.content.trim()
  return ellipsize(text, 80)
}

// ensure the sessions directory exists
function ensureDir(): void
{
  mkdirSync(sessionsDir(), { recursive: true })
}

// get the directory where sessions live
function sessionsDir(): string
{
  return coralHomePath('sessions')
}

// get the compact metadata index path
function sessionIndexPath(): string
{
  return join(sessionsDir(), 'index.json')
}

// get the file path for a session ID
function sessionPath(id: string): string
{
  return join(sessionsDir(), `${id}.json`)
}

// sort sessions newest-first by update time
function sortSessions(sessions: SessionMeta[]): SessionMeta[]
{
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// write the compact metadata index
function writeSessionIndex(sessions: SessionMeta[]): void
{
  const file: SessionIndexFile = {
    version: SESSION_INDEX_VERSION,
    sessions: sortSessions(sessions),
  }

  writeJsonFile(sessionIndexPath(), file)
}

// scan full session files only as a fallback for missing/corrupt indexes
function rebuildSessionIndex(): SessionMeta[]
{
  ensureDir()

  const sessions: SessionMeta[] = []
  const dir = sessionsDir()
  const files = readdirSync(dir).filter(
    (file) => file.endsWith('.json') && file !== 'index.json'
  )

  for (const file of files)
  {
    const session = readJsonObjectFile<SessionData>(join(dir, file))
    if (session?.meta)
    {
      sessions.push(session.meta)
    }
  }

  writeSessionIndex(sessions)
  return sortSessions(sessions)
}

// load the metadata index, rebuilding it if needed
function loadSessionIndex(): SessionMeta[]
{
  ensureDir()

  const index = readJsonObjectFile<SessionIndexFile>(sessionIndexPath())
  if (
    index?.version === SESSION_INDEX_VERSION &&
    Array.isArray(index.sessions)
  )
  {
    return sortSessions(index.sessions)
  }

  return rebuildSessionIndex()
}

// insert or replace a session entry in the metadata index
function upsertSessionIndex(meta: SessionMeta): void
{
  const sessions = loadSessionIndex().filter(
    (session) => session.id !== meta.id
  )
  sessions.push(meta)
  writeSessionIndex(sessions)
}

// count messages that are part of the conversation history
function countConversationMessages(messages: OllamaMessage[]): number
{
  return messages.filter((m) => m.role !== 'system').length
}

// write a session file & update the compact metadata index
function writeSessionData(session: SessionData): void
{
  ensureDir()
  writeJsonFile(sessionPath(session.meta.id), session)
  upsertSessionIndex(session.meta)
}

// create a new session & persist it
export function createSession(
  model: string,
  cwd: string,
  messages: OllamaMessage[],
  todos: TodoItem[] = []
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

  writeSessionData({ meta, messages, todos })

  return meta
}

// save (update) an existing session
export function saveSession(
  id: string,
  model: string,
  cwd: string,
  messages: OllamaMessage[],
  metaHint?: SessionMetaHint,
  todos: TodoItem[] = []
): SessionMeta
{
  ensureDir()

  const now = new Date().toISOString()
  const indexedMeta =
    metaHint?.createdAt && metaHint?.title
      ? undefined
      : loadSessionIndex().find((session) => session.id === id)
  const meta: SessionMeta = {
    id,
    model,
    cwd,
    createdAt: metaHint?.createdAt ?? indexedMeta?.createdAt ?? now,
    updatedAt: now,
    title: metaHint?.title ?? indexedMeta?.title ?? extractTitle(messages),
    messageCount: countConversationMessages(messages),
    compactionCount: metaHint?.compactionCount ?? indexedMeta?.compactionCount,
    lastCompactedAt: metaHint?.lastCompactedAt ?? indexedMeta?.lastCompactedAt,
  }

  writeSessionData({ meta, messages, todos })

  return meta
}

// load a session's messages by ID
export function loadSession(id: string): SessionData | undefined
{
  return readJsonObjectFile<SessionData>(sessionPath(id))
}

// list all sessions, sorted by updatedAt (newest first)
export function listSessions(): SessionMeta[]
{
  return loadSessionIndex()
}

// rename a session's title
export function renameSession(
  id: string,
  title: string
): SessionMeta | undefined
{
  const session = readJsonObjectFile<SessionData>(sessionPath(id))
  if (!session?.meta) return undefined

  session.meta.title = title
  session.meta.updatedAt = new Date().toISOString()

  writeSessionData(session)

  return session.meta
}
