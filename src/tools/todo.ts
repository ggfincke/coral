// src/tools/todo.ts
// maintain a structured task list for multi-step work

import type { Tool, ToolResult } from './tool.js'
import { pluralize } from '../utils/pluralize.js'
import {
  cloneTodoItems,
  validateTodoList,
  type TodoItem,
  type TodoStatus,
} from '../types/todo.js'

// model-facing confirmation glyphs
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
  display: {
    label: 'Todo',
    summarize: (args) =>
    {
      const n = Array.isArray(args.todos) ? args.todos.length : 0
      return pluralize(n, 'item')
    },
  },
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
  async execute(args, context): Promise<ToolResult>
  {
    if (!context?.todoState)
    {
      return { output: '', error: 'todo_write requires session todo state' }
    }

    const result = validateTodoList(args.todos)
    if (!result.ok)
    {
      return { output: '', error: result.error }
    }

    const before = context.todoState.snapshot()
    context.todoState.replace(result.todos)
    return {
      output: renderTodos(result.todos),
      todoChange: {
        before,
        after: cloneTodoItems(result.todos),
      },
    }
  },
}
