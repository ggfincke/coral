// src/tools/todo-store.ts
// in-memory task list shared between the todo tool & the TUI

const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export interface TodoItem
{
  content: string
  status: TodoStatus
}

const VALID_STATUS = new Set<TodoStatus>(TODO_STATUSES)

export function isTodoStatus(value: string): value is TodoStatus
{
  return VALID_STATUS.has(value as TodoStatus)
}

// parse one todo entry; returns undefined for invalid shapes
function parseTodoEntry(entry: unknown): TodoItem | undefined
{
  if (typeof entry !== 'object' || entry === null) return undefined

  const content = (entry as Record<string, unknown>).content
  const status = (entry as Record<string, unknown>).status

  if (typeof content !== 'string' || !content.trim()) return undefined
  if (typeof status !== 'string' || !isTodoStatus(status))
  {
    return undefined
  }

  return { content: content.trim(), status }
}

// lenient — for session restore; drops invalid entries, demotes extra in_progress
export function sanitizeTodos(raw: unknown): TodoItem[]
{
  if (!Array.isArray(raw)) return []

  const parsed = raw
    .map(parseTodoEntry)
    .filter((item): item is TodoItem => item !== undefined)

  let seenInProgress = false
  return parsed.map((item) =>
  {
    if (item.status === 'in_progress')
    {
      if (seenInProgress) return { ...item, status: 'pending' }
      seenInProgress = true
    }
    return item
  })
}

// strict — for todo_write; preserves existing error strings byte-for-byte
export function validateTodoList(
  raw: unknown
): { ok: true; todos: TodoItem[] } | { ok: false; error: string }
{
  if (!Array.isArray(raw))
  {
    return { ok: false, error: 'todo_write requires a todos array' }
  }

  const todos: TodoItem[] = []
  for (const entry of raw)
  {
    if (typeof entry !== 'object' || entry === null)
    {
      return { ok: false, error: 'each todo must be an object' }
    }

    const content = (entry as Record<string, unknown>).content
    const status = (entry as Record<string, unknown>).status

    if (typeof content !== 'string' || !content.trim())
    {
      return {
        ok: false,
        error: 'each todo needs a non-empty content string',
      }
    }
    if (typeof status !== 'string' || !isTodoStatus(status))
    {
      return {
        ok: false,
        error: 'each todo status must be pending, in_progress, or completed',
      }
    }

    todos.push({ content: content.trim(), status })
  }

  const inProgress = todos.filter((t) => t.status === 'in_progress').length
  if (inProgress > 1)
  {
    return { ok: false, error: 'only one todo may be in_progress at a time' }
  }

  return { ok: true, todos }
}

// model-facing confirmation glyphs (ASCII)
export const STATUS_MARK: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
}

// TUI panel & /todo command glyphs (unicode)
export const TODO_MARK: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
}

let todos: TodoItem[] = []
let listener: ((todos: TodoItem[]) => void) | null = null

export function getTodos(): TodoItem[]
{
  return todos
}

// replace the whole list & notify the TUI listener
export function setTodos(next: TodoItem[]): void
{
  todos = next
  listener?.([...todos])
}

export function clearTodos(): void
{
  setTodos([])
}

// register a single listener (the TUI) for live updates; pass null to detach
export function onTodosChanged(fn: ((todos: TodoItem[]) => void) | null): void
{
  listener = fn
}
