// src/session/store.ts
// session persistence — save & resume conversations to/from disk

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { OllamaMessage } from '../ollama/client.js'

// where sessions live on disk
const SESSIONS_DIR = join(homedir(), '.coral', 'sessions')
const SESSION_INDEX_PATH = join(SESSIONS_DIR, 'index.json')
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
}

// cached metadata passed back into saveSession to avoid disk reads
export interface SessionMetaHint
{
  createdAt?: string
  title?: string
}

// full session on disk
export interface SessionData
{
  meta: SessionMeta
  messages: OllamaMessage[]
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
  if (text.length > 80) return text.slice(0, 77) + '…'
  return text
}

// ensure the sessions directory exists
function ensureDir(): void
{
  mkdirSync(SESSIONS_DIR, { recursive: true })
}

// get the file path for a session ID
function sessionPath(id: string): string
{
  return join(SESSIONS_DIR, `${id}.json`)
}

// sort sessions newest-first by update time
function sortSessions(sessions: SessionMeta[]): SessionMeta[]
{
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// read & parse a JSON file, returning null when missing/corrupt
function readJsonFile<T>(path: string): T | null
{
  try
  {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  }
  catch
  {
    return null
  }
}

// write the compact metadata index
function writeSessionIndex(sessions: SessionMeta[]): void
{
  const file: SessionIndexFile = {
    version: SESSION_INDEX_VERSION,
    sessions: sortSessions(sessions),
  }

  writeFileSync(SESSION_INDEX_PATH, JSON.stringify(file, null, 2), 'utf-8')
}

// scan full session files only as a fallback for missing/corrupt indexes
function rebuildSessionIndex(): SessionMeta[]
{
  ensureDir()

  const sessions: SessionMeta[] = []
  const files = readdirSync(SESSIONS_DIR).filter(
    (file) => file.endsWith('.json') && file !== 'index.json'
  )

  for (const file of files)
  {
    const session = readJsonFile<SessionData>(join(SESSIONS_DIR, file))
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

  const index = readJsonFile<SessionIndexFile>(SESSION_INDEX_PATH)
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
  const sessions = loadSessionIndex().filter((session) => session.id !== meta.id)
  sessions.push(meta)
  writeSessionIndex(sessions)
}

// create a new session & persist it
export function createSession(
  model: string,
  cwd: string,
  messages: OllamaMessage[]
): SessionMeta
{
  ensureDir()

  const id = generateId()
  const now = new Date().toISOString()
  const nonSystemMessages = messages.filter((m) => m.role !== 'system')

  const meta: SessionMeta = {
    id,
    model,
    cwd,
    createdAt: now,
    updatedAt: now,
    title: extractTitle(messages),
    messageCount: nonSystemMessages.length,
  }

  const file: SessionData = { meta, messages }
  writeFileSync(sessionPath(id), JSON.stringify(file, null, 2), 'utf-8')
  upsertSessionIndex(meta)

  return meta
}

// save (update) an existing session
export function saveSession(
  id: string,
  model: string,
  cwd: string,
  messages: OllamaMessage[],
  metaHint?: SessionMetaHint
): SessionMeta
{
  ensureDir()

  const indexedMeta =
    metaHint?.createdAt && metaHint?.title
      ? undefined
      : loadSessionIndex().find((session) => session.id === id)
  const existingMeta = {
    createdAt: metaHint?.createdAt ?? indexedMeta?.createdAt,
    title: metaHint?.title ?? indexedMeta?.title,
  }
  const nonSystemMessages = messages.filter((m) => m.role !== 'system')
  const meta: SessionMeta = {
    id,
    model,
    cwd,
    createdAt: existingMeta.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: existingMeta.title ?? extractTitle(messages),
    messageCount: nonSystemMessages.length,
  }

  const file: SessionData = { meta, messages }
  writeFileSync(sessionPath(id), JSON.stringify(file, null, 2), 'utf-8')
  upsertSessionIndex(meta)

  return meta
}

// load a session's messages by ID
export function loadSession(id: string): SessionData | null
{
  return readJsonFile<SessionData>(sessionPath(id))
}

// list all sessions, sorted by updatedAt (newest first)
export function listSessions(): SessionMeta[]
{
  return loadSessionIndex()
}

// get the most recently updated session (for --resume)
export function getLatestSession(): SessionMeta | null
{
  const sessions = listSessions()
  return sessions.length > 0 ? sessions[0]! : null
}

// check if a session exists
export function sessionExists(id: string): boolean
{
  return existsSync(sessionPath(id))
}
