// src/types/undo.ts
// shared undo/redo state contracts

import type { OllamaMessage } from './inference.js'
import { cloneAttachmentReport } from './attachments.js'
import { cloneTodoItems, type TodoItem } from './todo.js'

// cap live effect history independently from the persisted byte cap
export const MAX_UNDO_TURNS = 10

export interface UndoFileChange
{
  path: string
  before: string | null
  after: string
}

export interface UndoTodoChange
{
  before: TodoItem[]
  after: TodoItem[]
}

export interface UndoTurn
{
  startIndex: number
  endIndex: number
  userMessage: string
  messages: OllamaMessage[]
  changes: UndoFileChange[]
  todoChange?: UndoTodoChange
}

export interface UndoResult
{
  ok: boolean
  message: string
  removedMessages?: number
  restoredMessages?: number
  changedFiles?: number
}

export interface UndoTurnAlignmentOptions
{
  // live undo requires the turn to still be the message-history tip
  requireLiveTail?: boolean
  // refuse turns that start inside the frozen compaction prefix
  frozenPrefixLength?: number
}

// shared alignment for live undo (strict) & session hydrate (relaxed)
export function isUndoTurnAligned(
  messages: OllamaMessage[],
  turn: Pick<UndoTurn, 'startIndex' | 'endIndex' | 'userMessage'>,
  options: UndoTurnAlignmentOptions = {}
): boolean
{
  if (turn.startIndex < 0 || turn.endIndex < turn.startIndex) return false
  if (turn.endIndex > messages.length) return false
  if (options.requireLiveTail && turn.endIndex !== messages.length) return false
  if (turn.startIndex < (options.frozenPrefixLength ?? 0)) return false
  const first = messages[turn.startIndex]
  return first?.role === 'user' && first.content === turn.userMessage
}

export function cloneMessages(messages: OllamaMessage[]): OllamaMessage[]
{
  return messages.map((message) =>
  {
    const cloned = structuredClone(message)
    if (message.attachmentReport)
    {
      cloned.attachmentReport = cloneAttachmentReport(message.attachmentReport)
    }
    return cloned
  })
}

export function cloneUndoTurn(turn: UndoTurn): UndoTurn
{
  const cloned: UndoTurn = {
    ...turn,
    messages: cloneMessages(turn.messages),
    changes: turn.changes.map((change) => ({ ...change })),
  }
  if (turn.todoChange)
  {
    cloned.todoChange = {
      before: cloneTodoItems(turn.todoChange.before),
      after: cloneTodoItems(turn.todoChange.after),
    }
  }

  return cloned
}
