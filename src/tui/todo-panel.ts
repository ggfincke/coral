// src/tui/todo-panel.ts
// render the active task list into bordered status lines

import chalk from 'chalk'
import type { TodoItem, TodoStatus } from '../tools/todo-store.js'
import { buildLabeledSeparator, buildRule } from './status-line.js'

export const TODO_MARK: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
}

// cap rendered rows so a long list can't swallow the transcript viewport
const MAX_ROWS = 8

function clip(text: string, width: number): string
{
  if (text.length <= width) return text
  return text.slice(0, Math.max(width - 1, 0)) + '…'
}

function pad(text: string, width: number): string
{
  return text + ' '.repeat(Math.max(width - text.length, 0))
}

// returns [] when the list is empty so callers can skip the panel entirely
export function buildTodoPanel(todos: TodoItem[], width: number): string[]
{
  if (todos.length === 0) return []

  const innerWidth = Math.max(width - 4, 12)
  const done = todos.filter((t) => t.status === 'completed').length
  const label = `tasks ${done}/${todos.length}`

  const top = `╭─${buildLabeledSeparator(innerWidth, label)}─╮`
  const bottom = `╰${buildRule(innerWidth + 2)}╯`
  const lines: string[] = [top]

  const shown = todos.slice(0, MAX_ROWS)
  for (const todo of shown)
  {
    // pad on plain text, then strike only the visible cell so width math holds
    const row = clip(`${TODO_MARK[todo.status]} ${todo.content}`, innerWidth)
    const padding = ' '.repeat(Math.max(innerWidth - row.length, 0))
    const cell = todo.status === 'completed' ? chalk.strikethrough(row) : row
    lines.push(`│ ${cell}${padding} │`)
  }

  const hidden = todos.length - shown.length
  if (hidden > 0)
  {
    lines.push(`│ ${pad(clip(`…+${hidden} more`, innerWidth), innerWidth)} │`)
  }

  lines.push(bottom)
  return lines
}
