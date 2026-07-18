// src/session/types.ts
// public hydrated session value contracts

import type { OllamaMessage } from '../types/inference.js'
import type { TodoItem } from '../types/todo.js'
import type { UndoTurn } from '../types/undo.js'

const SESSION_ID_PATTERN = /^[0-9a-f]{8}$/

export interface SessionMeta
{
  id: string
  model: string
  cwd: string
  createdAt: string
  updatedAt: string
  title: string
  messageCount: number
  compactionCount?: number
  lastCompactedAt?: string
}

export interface SessionMetaHint
{
  createdAt?: string
  title?: string
  compactionCount?: number
  lastCompactedAt?: string
}

// persisted session snapshot after hydration
export interface SessionData
{
  meta: SessionMeta
  messages: OllamaMessage[]
  // restore the task list with /resume
  todos?: TodoItem[]
  // live-tail turns that can still be reverted
  undo?: UndoTurn[]
  // turns undone from the live tail
  redo?: UndoTurn[]
}

export function isValidSessionId(id: string): boolean
{
  return SESSION_ID_PATTERN.test(id)
}
