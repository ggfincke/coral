// src/session/undo-state.ts
// persisted undo/redo stack shaping

import type { OllamaMessage } from '../types/inference.js'
import {
  cloneMessages,
  isUndoTurnAligned,
  MAX_UNDO_TURNS,
  type UndoFileChange,
  type UndoTodoChange,
  type UndoTurn,
} from '../types/undo.js'
import { cloneTodoItems } from '../types/todo.js'

// two-layer undo bounds: count caps live memory; byte cap caps disk snapshots
export { MAX_UNDO_TURNS } from '../types/undo.js'
export const DEFAULT_PERSISTED_UNDO_BYTE_CAP = 8 * 1024 * 1024

export interface PersistedUndoTurn
{
  startIndex: number
  endIndex: number
  userMessage: string
  messages?: OllamaMessage[]
  changes: UndoFileChange[]
  todoChange?: UndoTodoChange
}

export interface PersistedUndoState
{
  undo: PersistedUndoTurn[]
  redo: PersistedUndoTurn[]
}

export interface HydratedUndoState
{
  undo: UndoTurn[]
  redo: UndoTurn[]
}

interface SerializeOptions
{
  byteCap?: number
  maxTurns?: number
}

function cloneChanges(changes: UndoFileChange[]): UndoFileChange[]
{
  return changes.map((change) => ({ ...change }))
}

function cloneTodoChange(change: UndoTodoChange): UndoTodoChange
{
  return {
    before: cloneTodoItems(change.before),
    after: cloneTodoItems(change.after),
  }
}

function serializeTurn(
  turn: UndoTurn,
  includeMessages: boolean
): PersistedUndoTurn
{
  const persisted: PersistedUndoTurn = {
    startIndex: turn.startIndex,
    endIndex: turn.endIndex,
    userMessage: turn.userMessage,
    changes: cloneChanges(turn.changes),
  }

  if (includeMessages) persisted.messages = cloneMessages(turn.messages)
  if (turn.todoChange) persisted.todoChange = cloneTodoChange(turn.todoChange)
  return persisted
}

function stateBytes(state: PersistedUndoState): number
{
  return Buffer.byteLength(JSON.stringify(state), 'utf-8')
}

function dropOldestTurn(state: PersistedUndoState): boolean
{
  if (state.undo.length === 0 && state.redo.length === 0) return false
  if (state.redo.length === 0 || state.undo.length >= state.redo.length)
  {
    state.undo.shift()
    return true
  }

  state.redo.shift()
  return true
}

function capState(
  state: PersistedUndoState,
  byteCap: number
): PersistedUndoState
{
  if (!Number.isFinite(byteCap) || byteCap < 0) return state

  while (stateBytes(state) > byteCap)
  {
    if (!dropOldestTurn(state)) break
  }

  return state
}

function sliceNewestTurns(turns: UndoTurn[], maxTurns: number): UndoTurn[]
{
  if (!Number.isFinite(maxTurns) || maxTurns < 0) return turns
  return turns.slice(-maxTurns)
}

export function serializeUndoState(
  messages: OllamaMessage[],
  undo: UndoTurn[],
  redo: UndoTurn[],
  options: SerializeOptions = {}
): PersistedUndoState
{
  const maxTurns = options.maxTurns ?? MAX_UNDO_TURNS
  const cappedUndo = sliceNewestTurns(undo, maxTurns)
  const cappedRedo = sliceNewestTurns(redo, maxTurns)

  const state: PersistedUndoState = {
    undo: cappedUndo.map((turn) =>
      serializeTurn(turn, !isUndoTurnAligned(messages, turn))
    ),
    redo: cappedRedo.map((turn) => serializeTurn(turn, true)),
  }

  return capState(state, options.byteCap ?? DEFAULT_PERSISTED_UNDO_BYTE_CAP)
}

export function hydrateUndoTurn(
  messages: OllamaMessage[],
  turn: PersistedUndoTurn,
  requirePersistedMessages: boolean
): UndoTurn | undefined
{
  if (turn.messages)
  {
    const hydrated: UndoTurn = {
      ...turn,
      messages: cloneMessages(turn.messages),
      changes: cloneChanges(turn.changes),
    }
    if (turn.todoChange) hydrated.todoChange = cloneTodoChange(turn.todoChange)
    return hydrated
  }

  if (requirePersistedMessages) return undefined
  if (!isUndoTurnAligned(messages, turn)) return undefined

  const hydrated: UndoTurn = {
    ...turn,
    messages: cloneMessages(messages.slice(turn.startIndex, turn.endIndex)),
    changes: cloneChanges(turn.changes),
  }
  if (turn.todoChange) hydrated.todoChange = cloneTodoChange(turn.todoChange)
  return hydrated
}

export function hydrateUndoState(
  messages: OllamaMessage[],
  undo: PersistedUndoTurn[] = [],
  redo: PersistedUndoTurn[] = []
): HydratedUndoState
{
  return {
    undo: undo
      .map((turn) => hydrateUndoTurn(messages, turn, false))
      .filter((turn): turn is UndoTurn => turn !== undefined),
    redo: redo
      .map((turn) => hydrateUndoTurn(messages, turn, true))
      .filter((turn): turn is UndoTurn => turn !== undefined),
  }
}
