// src/tools/todo.ts
// maintain a structured task list for multi-step work

import type { Tool, ToolResult } from './tool.js'
import {
  setTodos,
  TODO_STATUSES,
  type TodoItem,
  type TodoStatus,
} from './todo-store.js'

const VALID_STATUS = new Set<TodoStatus>(TODO_STATUSES)

const STATUS_MARK: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
}

// render the stored list back to the model as a confirmation
function renderTodos(todos: TodoItem[]): string
{
  if (todos.length === 0) return 'Cleared the task list'
  return todos.map((t) => `${STATUS_MARK[t.status]} ${t.content}`).join('\n')
}

export const todoWriteTool: Tool = {
  name: 'todo_write',
  description:
    'Record or update your task list for multi-step work. Pass the full list ' +
    'each call — it replaces the previous one. Keep exactly one item ' +
    'in_progress while you work it & mark it completed when done. Skip this ' +
    'for simple single-step tasks.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: { type: 'object' },
        description:
          'The full task list — each item has content (string) & status ' +
          '(pending | in_progress | completed)',
      },
    },
    required: ['todos'],
  },
  async execute(args): Promise<ToolResult>
  {
    const raw = args.todos
    if (!Array.isArray(raw))
    {
      return { output: '', error: 'todo_write requires a todos array' }
    }

    const todos: TodoItem[] = []
    for (const entry of raw)
    {
      if (typeof entry !== 'object' || entry === null)
      {
        return { output: '', error: 'each todo must be an object' }
      }

      const content = (entry as Record<string, unknown>).content
      const status = (entry as Record<string, unknown>).status

      if (typeof content !== 'string' || !content.trim())
      {
        return {
          output: '',
          error: 'each todo needs a non-empty content string',
        }
      }
      if (
        typeof status !== 'string' ||
        !VALID_STATUS.has(status as TodoStatus)
      )
      {
        return {
          output: '',
          error: 'each todo status must be pending, in_progress, or completed',
        }
      }

      todos.push({ content: content.trim(), status: status as TodoStatus })
    }

    const inProgress = todos.filter((t) => t.status === 'in_progress').length
    if (inProgress > 1)
    {
      return { output: '', error: 'only one todo may be in_progress at a time' }
    }

    setTodos(todos)
    return { output: renderTodos(todos) }
  },
}
