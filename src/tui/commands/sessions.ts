// src/tui/commands/sessions.ts
// saved-session lifecycle commands

import { resolveResumeSession } from '../../session/resume.js'
import { listSessions } from '../../session/store.js'
import { pluralize } from '../../utils/pluralize.js'
import { style } from '../theme.js'
import type { Command } from './contracts.js'
import {
  formatTuiResumeResolution,
  formatTuiSessionList,
} from './session-output.js'
import { systemBlock } from './output.js'

// /sessions command

const sessionsCommand: Command = {
  name: 'sessions',
  aliases: ['ls'],
  description: 'List recent saved sessions',
  execute(args, ctx)
  {
    const count = args ? parseInt(args, 10) : 10
    const limit = Number.isFinite(count) && count > 0 ? count : 10
    const sessions = listSessions().slice(0, limit)

    ctx.pushOutput(
      systemBlock(formatTuiSessionList(sessions, ctx.sessionLabelId))
    )
  },
}

// /resume command

const resumeCommand: Command = {
  name: 'resume',
  description: 'Resume a saved session (no args = latest)',
  execute(args, ctx)
  {
    const target = resolveResumeSession({
      requestedId: args,
      currentSessionId: ctx.sessionLabelId,
      allowPrefix: true,
      requireExistingCwd: true,
    })

    if (target.type !== 'target')
    {
      ctx.pushOutput(systemBlock(formatTuiResumeResolution(target)))
      return
    }

    const saved = ctx.saveCurrentSession()
    if (saved.status === 'error' || saved.status === 'stale')
    {
      ctx.pushTerminalOutput(
        systemBlock('Current session could not be saved; resume was canceled.')
      )
      return
    }

    if (ctx.resumeSession(target.session.id))
    {
      ctx.pushOutput(systemBlock(formatTuiResumeResolution(target)))
      return
    }

    ctx.pushOutput(systemBlock(`Failed to load session: ${target.session.id}`))
  },
}

// /rename command

const renameCommand: Command = {
  name: 'rename',
  description: 'Rename the current session',
  execute(args, ctx)
  {
    if (!ctx.sessionLabelId)
    {
      ctx.pushOutput(
        systemBlock('No active session to rename. Send a message first.')
      )
      return
    }

    if (!args.trim())
    {
      const sessions = listSessions()
      const current = sessions.find((s) => s.id === ctx.sessionLabelId)
      const title = current?.title ?? '(unknown)'
      ctx.pushOutput(
        systemBlock(
          `Current session: ${style('user')(ctx.sessionLabelId)}\n` +
            `Title: ${title}\n\n` +
            `Usage: ${style('user')('/rename <new title>')}`
        )
      )
      return
    }

    const ok = ctx.renameCurrentSession(args.trim())

    if (ok)
    {
      ctx.pushOutput(systemBlock(`Session renamed to: ${args.trim()}`))
    }
    else
    {
      ctx.pushOutput(systemBlock('Failed to rename session.'))
    }
  },
}

// /new command

const newCommand: Command = {
  name: 'new',
  description: 'Save current session & start a new conversation',
  execute(_args, ctx)
  {
    const saved = ctx.saveCurrentSession()
    if (saved.status === 'error' || saved.status === 'stale')
    {
      ctx.pushTerminalOutput(
        systemBlock(
          'Current session could not be saved; the new conversation was not started.'
        )
      )
      return
    }

    const cleared = ctx.agent.clearHistory()
    ctx.clearSession()

    const parts: string[] = []
    if (saved.status === 'saved')
    {
      parts.push(`Session ${saved.id} saved`)
    }
    parts.push(
      `New conversation started (${pluralize(cleared, 'message')} cleared)`
    )

    ctx.pushOutput(systemBlock(parts.join(' · ')))
  },
}

export const sessionCommands = {
  sessions: sessionsCommand,
  resume: resumeCommand,
  rename: renameCommand,
  new: newCommand,
} satisfies Record<string, Command>
