// src/tools/todo-store.ts
// in-memory task list shared between the todo tool & the TUI

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem
{
  content: string
  status: TodoStatus
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
