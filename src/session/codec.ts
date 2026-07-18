// src/session/codec.ts
// persisted session schema validation and transformation

import {
  isAttachmentSkipReason,
  MAX_ATTACHMENT_OMITTED_OVER_BUDGET,
  MAX_ATTACHMENT_REPORT_ITEMS,
  MAX_ATTACHMENT_REPORT_PATH_CHARS,
} from '../types/attachments.js'
import type { OllamaMessage } from '../types/inference.js'
import { isTodoStatus, type TodoItem } from '../types/todo.js'
import { isPlainObject } from '../utils/guards.js'
import {
  hydrateUndoState,
  serializeUndoState,
  type PersistedUndoTurn,
} from './undo-state.js'
import {
  isValidSessionId,
  type SessionData,
  type SessionMeta,
} from './types.js'

const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

interface SessionFileData
{
  meta: SessionMeta
  messages: OllamaMessage[]
  todos?: TodoItem[]
  undo?: PersistedUndoTurn[]
  redo?: PersistedUndoTurn[]
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

export function decodeSessionData(value: unknown): SessionData | undefined
{
  if (!isSessionFileData(value)) return undefined

  const undoState = hydrateUndoState(value.messages, value.undo, value.redo)
  return {
    meta: value.meta,
    messages: value.messages,
    todos: value.todos,
    undo: value.undo === undefined ? undefined : undoState.undo,
    redo: value.redo === undefined ? undefined : undoState.redo,
  }
}

export function encodeSessionData(session: SessionData): object
{
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
  return file
}
