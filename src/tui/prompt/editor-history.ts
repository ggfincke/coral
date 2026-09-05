// src/tui/prompt/editor-history.ts
// pure undo-stack & kill-ring memory for the prompt editor

export interface EditorSnapshot
{
  readonly value: string
  readonly cursorOffset: number
}

export interface EditorMemory
{
  readonly undoStack: readonly EditorSnapshot[]
  // whether the previous committed edit was a single-character insertion;
  // consecutive char inserts coalesce into one undo unit
  readonly lastOpCharInsert: boolean
}

export const EMPTY_EDITOR_MEMORY: EditorMemory = {
  undoStack: [],
  lastOpCharInsert: false,
}

const MAX_UNDO_DEPTH = 100
const MAX_KILL_ENTRIES = 10

export type EditOpKind = 'char-insert' | 'other'

// record the pre-edit state; char-insert runs collapse so ctrl+_ undoes a
// typed sentence instead of one letter at a time
export function pushUndo(
  memory: EditorMemory,
  snapshot: EditorSnapshot,
  op: EditOpKind
): EditorMemory
{
  const coalesce = op === 'char-insert' && memory.lastOpCharInsert
  if (coalesce) return { ...memory, lastOpCharInsert: true }

  const nextStack = [...memory.undoStack, snapshot]
  if (nextStack.length > MAX_UNDO_DEPTH)
  {
    nextStack.shift()
  }
  return { undoStack: nextStack, lastOpCharInsert: op === 'char-insert' }
}

// pop the newest past state to restore; returns null when nothing to undo
export function popUndo(
  memory: EditorMemory,
  current: EditorSnapshot
): { memory: EditorMemory; restore: EditorSnapshot | null }
{
  if (memory.undoStack.length === 0)
  {
    return { memory: { ...memory, lastOpCharInsert: false }, restore: current }
  }

  const stack = [...memory.undoStack]
  const restore = stack.pop() ?? current
  return {
    memory: { undoStack: stack, lastOpCharInsert: false },
    restore: restore ?? current,
  }
}

// kill ring, newest first (readline order); empty kills never enter
export function pushKill(
  ring: readonly string[],
  text: string
): readonly string[]
{
  if (!text) return ring
  const next = [text, ...ring.filter((entry) => entry !== text)]
  return next.slice(0, MAX_KILL_ENTRIES)
}

// yank-pop cycle position math: wraps through the whole ring
export function nextKillIndex(ringLength: number, index: number): number
{
  if (ringLength <= 0) return 0
  return (index + 1) % ringLength
}
