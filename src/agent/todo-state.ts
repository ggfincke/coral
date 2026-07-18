// src/agent/todo-state.ts
// per-agent todo state w/ immutable snapshots & subscriptions

import {
  cloneTodoItems,
  sanitizeTodos,
  type TodoItem,
  type TodoListener,
  type TodoState,
} from '../types/todo.js'

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
    // observers cannot alter mutation semantics or block sibling notifications
    for (const listener of [...this.listeners])
    {
      try
      {
        listener(this.snapshot())
      }
      catch
      {
        // UI notification failures are isolated from the session state change
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
