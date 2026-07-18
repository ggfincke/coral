// src/tui/commands/conversation.ts
// conversation-history and task-list commands

import { copyToClipboard } from '../../utils/clipboard.js'
import { pluralize } from '../../utils/pluralize.js'
import { style } from '../theme.js'
import { lastAssistantText, lastCodeBlock } from '../shell/copy.js'
import type { Command } from './contracts.js'
import {
  formatManualCompactionResult,
  formatTodoList,
  formatUndoResult,
} from './conversation-output.js'
import { committedSaveWarning, systemBlock } from './output.js'

// /clear command

const clearCommand: Command = {
  name: 'clear',
  aliases: ['reset'],
  description: 'Clear conversation history & transcript',
  execute(_args, ctx)
  {
    const cleared = ctx.agent.clearHistory()
    ctx.clearSession()
    ctx.pushOutput(
      systemBlock(
        `Conversation cleared (${pluralize(cleared, 'message')} removed)`
      )
    )
  },
}

// /compact command

const compactCommand: Command = {
  name: 'compact',
  description: 'Compact conversation history to free context space',
  async execute(_args, ctx)
  {
    const msgCount = ctx.agent.getMessageCount()
    if (msgCount < 4)
    {
      ctx.pushOutput(systemBlock('Conversation too short to compact'))
      return
    }

    ctx.pushOutput(systemBlock('Compacting conversation...'))

    const result = await ctx.agent.forceCompact(ctx.signal)

    if (!result)
    {
      if (ctx.signal?.aborted)
      {
        ctx.pushTerminalOutput(systemBlock('Compaction interrupted'))
        return
      }
      ctx.pushOutput(
        systemBlock('Compaction skipped — not enough context to summarize')
      )
      return
    }

    ctx.rebuildTranscript()
    const saved = ctx.saveCurrentSession()
    const warning = committedSaveWarning(saved, 'Compaction completed')
    ctx.pushTerminalOutput(
      systemBlock(formatManualCompactionResult(result)),
      ...(warning ? [warning] : [])
    )
  },
}

// undo and redo commands

const undoCommand: Command = {
  name: 'undo',
  description:
    'Undo the last turn & revert captured file edits (session snapshots under ~/.coral/sessions/ can duplicate file contents incl. secrets — treat like the workspace)',
  async execute(_args, ctx)
  {
    if (ctx.signal?.aborted) return
    const result = await ctx.agent.undoLastTurn(ctx.signal)
    if (!result.ok)
    {
      ctx.pushOutput(systemBlock(result.message))
      return
    }

    ctx.rebuildTranscript()
    ctx.resetTokenUsage()
    const saved = ctx.saveCurrentSession()
    const warning = committedSaveWarning(saved, 'Undo completed')
    ctx.pushTerminalOutput(
      systemBlock(formatUndoResult(result)),
      ...(warning ? [warning] : [])
    )
  },
}

const redoCommand: Command = {
  name: 'redo',
  description: 'Redo the last undone turn & reapply captured edits',
  async execute(_args, ctx)
  {
    if (ctx.signal?.aborted) return
    const result = await ctx.agent.redoLastTurn(ctx.signal)
    if (!result.ok)
    {
      ctx.pushOutput(systemBlock(result.message))
      return
    }

    ctx.rebuildTranscript()
    ctx.resetTokenUsage()
    const saved = ctx.saveCurrentSession()
    const warning = committedSaveWarning(saved, 'Redo completed')
    ctx.pushTerminalOutput(
      systemBlock(formatUndoResult(result)),
      ...(warning ? [warning] : [])
    )
  },
}

// /copy command

const copyCommand: Command = {
  name: 'copy',
  description:
    "Copy the last response (or its code block w/ 'code') to clipboard",
  async execute(args, ctx)
  {
    const text = lastAssistantText(ctx.agent.getMessages())
    if (!text)
    {
      ctx.pushOutput(systemBlock('Nothing to copy — no response yet'))
      return
    }

    const wantCode = args.trim().toLowerCase() === 'code'
    let payload = text
    let label = 'response'

    if (wantCode)
    {
      const block = lastCodeBlock(text)
      if (!block)
      {
        ctx.pushOutput(systemBlock('No code block in the last response'))
        return
      }
      payload = block
      label = 'code block'
    }

    const result = await copyToClipboard(payload)
    if (!result.ok)
    {
      ctx.pushOutput(
        systemBlock(
          `Failed to copy: ${result.error ?? 'clipboard unavailable'}`
        )
      )
      return
    }

    const lineCount = payload.split('\n').length
    const detail = pluralize(lineCount, 'line')
    ctx.pushOutput(systemBlock(`Copied last ${label} to clipboard (${detail})`))
  },
}

// /todo command

const todoCommand: Command = {
  name: 'todo',
  description: 'Show the task list, or clear it w/ /todo clear',
  execute(args, ctx)
  {
    const arg = args.trim().toLowerCase()

    if (arg === 'clear')
    {
      ctx.agent.clearTodos()
      // flush the cleared list to disk so resume doesn't bring it back
      const saved = ctx.saveCurrentSession()
      const warning = committedSaveWarning(saved, 'Task list cleared')
      ctx.pushTerminalOutput(
        systemBlock('Task list cleared'),
        ...(warning ? [warning] : [])
      )
      return
    }

    if (arg)
    {
      ctx.pushOutput(
        systemBlock(
          `Unknown option: "${arg}"\n` +
            `Usage: ${style('user')('/todo')} or ${style('user')('/todo clear')}`
        )
      )
      return
    }

    const todos = ctx.agent.getTodos()
    if (todos.length === 0)
    {
      ctx.pushOutput(systemBlock('No tasks yet'))
      return
    }

    ctx.pushOutput(systemBlock(formatTodoList(todos)))
  },
}

export const conversationCommands = {
  clear: clearCommand,
  compact: compactCommand,
  undo: undoCommand,
  redo: redoCommand,
  copy: copyCommand,
  todo: todoCommand,
} satisfies Record<string, Command>
