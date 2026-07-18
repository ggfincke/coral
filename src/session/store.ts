// src/session/store.ts
// session persistence — save & resume conversations to/from disk

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { OllamaMessage } from '../types/inference.js'
import { isTodoStatus, type TodoItem } from '../types/todo.js'
import type { UndoTurn } from '../types/undo.js'
import {
  isAttachmentSkipReason,
  MAX_ATTACHMENT_OMITTED_OVER_BUDGET,
  MAX_ATTACHMENT_REPORT_ITEMS,
  MAX_ATTACHMENT_REPORT_PATH_CHARS,
} from '../types/attachments.js'
import {
  hydrateUndoState,
  serializeUndoState,
  type PersistedUndoTurn,
} from './undo-state.js'
import { coralHomePath } from '../utils/coral-home.js'
import { ellipsize } from '../utils/ellipsize.js'
import { ensurePrivateDir } from '../utils/fs.js'
import { isPlainObject } from '../utils/guards.js'
import { readJsonObjectFile, writeJsonFile } from '../utils/json.js'

const SESSION_ID_PATTERN = /^[0-9a-f]{8}$/
const SESSION_FILE_PATTERN = /^([0-9a-f]{8})\.json$/
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

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
  // undo records for live-tail turns that can still be reverted
  undo?: UndoTurn[]
  // redo records for turns undone from the live tail
  redo?: UndoTurn[]
}

interface SessionFileData
{
  meta: SessionMeta
  messages: OllamaMessage[]
  todos?: TodoItem[]
  undo?: PersistedUndoTurn[]
  redo?: PersistedUndoTurn[]
}

// generate an 8-char hex session ID
function generateId(): string
{
  return randomBytes(4).toString('hex')
}

export function isValidSessionId(id: string): boolean
{
  return SESSION_ID_PATTERN.test(id)
}

function isNonNegativeInteger(value: unknown): boolean
{
  return Number.isInteger(value) && Number(value) >= 0
}

function isToolCall(value: unknown): boolean
{
  if (!isPlainObject(value)) return false
  if (value.type !== undefined && value.type !== 'function') return false

  const fn = value.function
  if (!isPlainObject(fn)) return false
  if (fn.index !== undefined && !Number.isInteger(fn.index)) return false
  if (typeof fn.name !== 'string') return false
  return isPlainObject(fn.arguments)
}

function isAttachmentReport(value: unknown): boolean
{
  if (!isPlainObject(value)) return false
  if (
    !Array.isArray(value.attached) ||
    !value.attached.every(
      (entry) =>
        isPlainObject(entry) &&
        typeof entry.path === 'string' &&
        entry.path.length > 0 &&
        entry.path.length <= MAX_ATTACHMENT_REPORT_PATH_CHARS &&
        typeof entry.truncated === 'boolean'
    )
  )
  {
    return false
  }
  if (
    !Array.isArray(value.skipped) ||
    !value.skipped.every(
      (entry) =>
        isPlainObject(entry) &&
        typeof entry.path === 'string' &&
        entry.path.length > 0 &&
        entry.path.length <= MAX_ATTACHMENT_REPORT_PATH_CHARS &&
        isAttachmentSkipReason(entry.reason)
    )
  )
  {
    return false
  }
  if (
    value.attached.length + value.skipped.length >
    MAX_ATTACHMENT_REPORT_ITEMS
  )
  {
    return false
  }
  return (
    value.omittedOverBudget === undefined ||
    (Number.isSafeInteger(value.omittedOverBudget) &&
      Number(value.omittedOverBudget) >= 0 &&
      Number(value.omittedOverBudget) <= MAX_ATTACHMENT_OMITTED_OVER_BUDGET)
  )
}

function isOllamaMessage(value: unknown): value is OllamaMessage
{
  if (!isPlainObject(value)) return false
  if (typeof value.role !== 'string' || !MESSAGE_ROLES.has(value.role))
  {
    return false
  }
  if (typeof value.content !== 'string') return false
  if (
    value.displayContent !== undefined &&
    typeof value.displayContent !== 'string'
  )
  {
    return false
  }
  if (
    value.attachmentReport !== undefined &&
    !isAttachmentReport(value.attachmentReport)
  )
  {
    return false
  }
  if (value.thinking !== undefined && typeof value.thinking !== 'string')
  {
    return false
  }
  if (value.tool_name !== undefined && typeof value.tool_name !== 'string')
  {
    return false
  }
  if (
    value.tool_calls !== undefined &&
    (!Array.isArray(value.tool_calls) || !value.tool_calls.every(isToolCall))
  )
  {
    return false
  }

  return true
}

function isTodoItem(value: unknown): value is TodoItem
{
  if (!isPlainObject(value)) return false
  if (typeof value.content !== 'string' || !value.content.trim()) return false
  return typeof value.status === 'string' && isTodoStatus(value.status)
}

function isUndoFileChange(value: unknown): boolean
{
  if (!isPlainObject(value)) return false
  if (typeof value.path !== 'string' || !value.path) return false
  if (value.before !== null && typeof value.before !== 'string') return false
  return typeof value.after === 'string'
}

function isUndoTodoChange(value: unknown): boolean
{
  if (!isPlainObject(value)) return false
  return (
    Array.isArray(value.before) &&
    value.before.every(isTodoItem) &&
    Array.isArray(value.after) &&
    value.after.every(isTodoItem)
  )
}

function isPersistedUndoTurn(value: unknown): value is PersistedUndoTurn
{
  if (!isPlainObject(value)) return false
  if (!isNonNegativeInteger(value.startIndex)) return false
  if (!isNonNegativeInteger(value.endIndex)) return false
  if (Number(value.endIndex) < Number(value.startIndex)) return false
  if (typeof value.userMessage !== 'string') return false
  if (value.messages !== undefined)
  {
    if (
      !Array.isArray(value.messages) ||
      !value.messages.every(isOllamaMessage)
    )
    {
      return false
    }
  }
  if (!Array.isArray(value.changes) || !value.changes.every(isUndoFileChange))
  {
    return false
  }
  return value.todoChange === undefined || isUndoTodoChange(value.todoChange)
}

function isSessionMeta(value: unknown): value is SessionMeta
{
  if (!isPlainObject(value)) return false
  if (typeof value.id !== 'string' || !isValidSessionId(value.id)) return false
  if (typeof value.model !== 'string') return false
  if (typeof value.cwd !== 'string') return false
  if (typeof value.createdAt !== 'string') return false
  if (typeof value.updatedAt !== 'string') return false
  if (typeof value.title !== 'string') return false
  if (!isNonNegativeInteger(value.messageCount)) return false
  if (
    value.compactionCount !== undefined &&
    !isNonNegativeInteger(value.compactionCount)
  )
  {
    return false
  }
  if (
    value.lastCompactedAt !== undefined &&
    typeof value.lastCompactedAt !== 'string'
  )
  {
    return false
  }

  return true
}

function isSessionFileData(value: unknown): value is SessionFileData
{
  if (!isPlainObject(value)) return false
  if (!isSessionMeta(value.meta)) return false
  if (
    !Array.isArray(value.messages) ||
    !value.messages.every(isOllamaMessage)
  )
  {
    return false
  }
  if (value.todos !== undefined)
  {
    if (!Array.isArray(value.todos) || !value.todos.every(isTodoItem))
    {
      return false
    }
  }
  if (value.undo !== undefined)
  {
    if (!Array.isArray(value.undo) || !value.undo.every(isPersistedUndoTurn))
    {
      return false
    }
  }
  if (value.redo !== undefined)
  {
    if (!Array.isArray(value.redo) || !value.redo.every(isPersistedUndoTurn))
    {
      return false
    }
  }

  return true
}

function hydrateSessionData(file: SessionFileData): SessionData
{
  const undoState = hydrateUndoState(file.messages, file.undo, file.redo)
  return {
    meta: file.meta,
    messages: file.messages,
    todos: file.todos,
    undo: file.undo === undefined ? undefined : undoState.undo,
    redo: file.redo === undefined ? undefined : undoState.redo,
  }
}

function readSessionData(path: string): SessionData | undefined
{
  const file = readJsonObjectFile<SessionFileData>(path)
  if (!isSessionFileData(file)) return undefined
  return hydrateSessionData(file)
}

// extract a title from the first user message
function extractTitle(messages: OllamaMessage[]): string
{
  const firstUser = messages.find((m) => m.role === 'user')
  if (!firstUser) return '(empty session)'

  const text = (firstUser.displayContent ?? firstUser.content).trim()
  return ellipsize(text, 80)
}

// ensure the sessions directory exists
function ensureDir(): void
{
  ensurePrivateDir(coralHomePath())
  ensurePrivateDir(sessionsDir())
}

// get the directory where sessions live
function sessionsDir(): string
{
  return coralHomePath('sessions')
}

// get the file path for a session ID
function sessionPath(id: string): string
{
  if (!isValidSessionId(id))
  {
    throw new Error(`Invalid session ID: ${id}`)
  }
  return join(sessionsDir(), `${id}.json`)
}

// sort sessions newest-first by update time
function sortSessions(sessions: SessionMeta[]): SessionMeta[]
{
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// discover sessions from their authoritative files. legacy index.json remains
// untouched but cannot hide a valid session or supply stale metadata
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

// count messages that are part of the conversation history
function countConversationMessages(messages: OllamaMessage[]): number
{
  return messages.filter((m) => m.role !== 'system').length
}

// replace one complete session snapshot. concurrent saves of the same ID use
// whole-file last-completed-replacement wins semantics
function writeSessionData(session: SessionData): void
{
  ensureDir()
  const undoState = serializeUndoState(
    session.messages,
    session.undo ?? [],
    session.redo ?? []
  )
  const file: SessionFileData = {
    meta: session.meta,
    messages: session.messages,
    todos: session.todos,
    undo: session.undo === undefined ? undefined : undoState.undo,
    redo: session.redo === undefined ? undefined : undoState.redo,
  }

  writeJsonFile(sessionPath(session.meta.id), file)
}

// create a new session & persist it
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

// save (update) an existing session
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

// load a session's messages by ID
export function loadSession(id: string): SessionData | undefined
{
  if (!isValidSessionId(id)) return undefined

  const session = readSessionData(sessionPath(id))
  if (!session) return undefined
  if (session.meta.id !== id) return undefined
  return session
}

// list all sessions, sorted by updatedAt (newest first)
export function listSessions(): SessionMeta[]
{
  return discoverSessions()
}

// rename a session's title
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
