// src/types/undo.ts
// shared undo/redo state contracts

import type { TodoItem } from '../tools/todo-store.js'
import type { OllamaMessage } from './inference.js'

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

export function cloneTodoItems(todos: TodoItem[]): TodoItem[]
{
  return todos.map((todo) => ({ ...todo }))
}

export function cloneMessages(messages: OllamaMessage[]): OllamaMessage[]
{
  return messages.map((message) =>
  {
    const cloned: OllamaMessage = { ...message }
    if (message.tool_calls)
    {
      cloned.tool_calls = message.tool_calls.map((call) => ({
        ...call,
        function: {
          ...call.function,
          arguments: { ...call.function.arguments },
        },
      }))
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
