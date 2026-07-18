// src/agent/state/todos.ts
// per-agent todo state with immutable snapshots and subscriptions

import {
  cloneTodoItems,
  sanitizeTodos,
  type TodoItem,
  type TodoListener,
  type TodoState,
} from '../../types/todo.js'

export class AgentTodoState implements TodoState
{
  private todos: TodoItem[]
  private readonly listeners = new Set<TodoListener>()

  constructor(initialTodos: unknown = [])
  {
    this.todos = sanitizeTodos(initialTodos)
  }

  snapshot(): TodoItem[]
  {
    return cloneTodoItems(this.todos)
  }

  replace(todos: readonly TodoItem[]): void
  {
    this.todos = sanitizeTodos(todos)
    // isolate observers so they cannot alter state or block sibling notifications
    for (const listener of [...this.listeners])
    {
      try
      {
        listener(this.snapshot())
      }
      catch
      {
        // keep UI notification failures from rolling back the state change
      }
    }
  }

  clear(): void
  {
    this.replace([])
  }

  subscribe(listener: TodoListener): () => void
  {
    this.listeners.add(listener)
    return () =>
    {
      this.listeners.delete(listener)
    }
  }
}
