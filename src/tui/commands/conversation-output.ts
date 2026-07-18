// src/tui/commands/conversation-output.ts
// format conversation, compaction, undo, redo, and task outcomes

import type { CompactionResult } from '../../agent/agent.js'
import type { TodoItem } from '../../types/todo.js'
import { pluralize } from '../../utils/pluralize.js'
import { formatTokenCount } from '../shell/metrics.js'
import { strikeIfDone, todoRowText } from '../transcript/todo-panel.js'
import { coralHeader } from './output.js'

export function formatManualCompactionResult(result: CompactionResult): string
{
  const savedTokens = result.beforeTokens - result.afterTokens
  const savedMessages = result.beforeMessages - result.afterMessages
  return [
    'Context compacted',
    `  ${result.beforeMessages} messages -> ${result.afterMessages} messages (${savedMessages} summarized)`,
    `  ~${formatTokenCount(result.beforeTokens)} -> ~${formatTokenCount(result.afterTokens)} tokens (${formatTokenCount(savedTokens)} freed)`,
    '  Undo history cleared',
  ].join('\n')
}

export function formatAutoCompactionResult(result: CompactionResult): string
{
  const savedTokens = result.beforeTokens - result.afterTokens
  if (result.type === 'pruned')
  {
    return `Auto-pruned ${result.prunedResults ?? 0} old tool results (~${formatTokenCount(savedTokens)} tokens freed)`
  }

  const header =
    result.type === 'trimmed'
      ? 'Context trimmed to recent history (summarization unavailable)'
      : 'Context auto-compacted'
  return [
    header,
    `  ${result.beforeMessages} -> ${result.afterMessages} messages`,
    `  ~${formatTokenCount(result.beforeTokens)} -> ~${formatTokenCount(result.afterTokens)} tokens (~${formatTokenCount(savedTokens)} freed)`,
    '  Undo history cleared',
  ].join('\n')
}

export function formatUndoResult(result: {
  message: string
  removedMessages?: number
  restoredMessages?: number
  changedFiles?: number
}): string
{
  const details: string[] = []
  if (result.removedMessages !== undefined)
  {
    details.push(`${pluralize(result.removedMessages, 'message')} removed`)
  }
  if (result.restoredMessages !== undefined)
  {
    details.push(`${pluralize(result.restoredMessages, 'message')} restored`)
  }
  if (result.changedFiles !== undefined)
  {
    details.push(`${pluralize(result.changedFiles, 'file')} updated`)
  }
  return details.length > 0
    ? `${result.message} (${details.join(', ')})`
    : result.message
}

export function formatTodoList(todos: TodoItem[]): string
{
  const lines: string[] = [coralHeader('tasks'), '']
  for (const todo of todos)
  {
    lines.push(`  ${strikeIfDone(todo, todoRowText(todo))}`)
  }
  return lines.join('\n')
}
