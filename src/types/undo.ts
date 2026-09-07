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

// shared alignment for live undo (strict) and session hydration (relaxed)
export function isUndoTurnAligned(
  messages: readonly OllamaMessage[],
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

// aligned undo intervals identify internal corrective prompts inside a turn;
// older/pruned histories lack this provenance and retain the role-based view
export function findUserTurnStarts(
  messages: readonly OllamaMessage[],
  turns: readonly UndoTurn[] = []
): number[]
{
  const aligned = turns.filter(
    (turn) =>
      Number.isInteger(turn.startIndex) &&
      Number.isInteger(turn.endIndex) &&
      turn.endIndex > turn.startIndex &&
      turn.messages.length === turn.endIndex - turn.startIndex &&
      isUndoTurnAligned(messages, turn)
  )
  const intervals = aligned.filter(
    (turn) =>
      !aligned.some(
        (other) =>
          other !== turn &&
          other.startIndex < turn.endIndex &&
          turn.startIndex < other.endIndex
      )
  )
  const starts: number[] = []
  for (let index = 0; index < messages.length; index++)
  {
    if (messages[index]?.role !== 'user') continue
    if (
      intervals.some((turn) => index > turn.startIndex && index < turn.endIndex)
    )
      continue
    starts.push(index)
  }
  return starts
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
