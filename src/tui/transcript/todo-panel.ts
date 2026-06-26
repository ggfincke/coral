// src/tui/transcript/todo-panel.ts
// render the active task list into bordered status lines

import chalk from 'chalk'
import { TODO_MARK, type TodoItem } from '../../tools/todo-store.js'
import { ellipsize } from '../../utils/ellipsize.js'
import { boxFrame } from '../run/status-line.js'
import { padEnd } from '../wrap.js'

// cap rendered rows so a long list can't swallow the transcript viewport
const MAX_ROWS = 8

export function todoRowText(todo: TodoItem): string
{
  return `${TODO_MARK[todo.status]} ${todo.content}`
}

export function strikeIfDone(todo: TodoItem, text: string): string
{
  return todo.status === 'completed' ? chalk.strikethrough(text) : text
}

// returns [] when the list is empty so callers can skip the panel entirely
export function buildTodoPanel(todos: TodoItem[], width: number): string[]
{
  if (todos.length === 0) return []

  const done = todos.filter((t) => t.status === 'completed').length
  const frame = boxFrame(width, `tasks ${done}/${todos.length}`)
  const lines: string[] = [frame.top]

  const shown = todos.slice(0, MAX_ROWS)
  for (const todo of shown)
  {
    // ellipsize -> pad on plain text, then strike only the visible cell
    const row = ellipsize(todoRowText(todo), frame.innerWidth)
    const padded = padEnd(row, frame.innerWidth)
    const cell = strikeIfDone(todo, padded)
    lines.push(frame.row(cell))
  }

  const hidden = todos.length - shown.length
  if (hidden > 0)
  {
    lines.push(frame.row(ellipsize(`…+${hidden} more`, frame.innerWidth)))
  }

  lines.push(frame.bottom)
  return lines
}
