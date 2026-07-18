// src/tui/commands/session-output.ts
// format saved-session lists and resume outcomes for CLI and TUI

import chalk from 'chalk'
import type { ResumeSessionResolution } from '../../session/resume.js'
import type { SessionMeta } from '../../session/types.js'
import { sanitizeUntrustedText } from '../transcript/sanitize.js'
import { style } from '../theme.js'
import { coralHeader } from './output.js'

function formatSessionDate(session: SessionMeta): string
{
  return new Date(session.updatedAt).toLocaleString()
}

function formatSessionCount(session: SessionMeta): string
{
  return `${session.messageCount} msgs`
}

function cleanSessionId(session: SessionMeta): string
{
  return sanitizeUntrustedText(session.id)
}

function cleanSessionModel(session: SessionMeta): string
{
  return sanitizeUntrustedText(session.model)
}

export function formatCliSessionList(sessions: SessionMeta[]): string
{
  if (sessions.length === 0) return 'No saved sessions.'

  const lines: string[] = [`${sessions.length} saved session(s):`, '']
  for (const session of sessions)
  {
    lines.push(
      `  ${cleanSessionId(session)}  ${cleanSessionModel(session)}  ${formatSessionDate(session)}  (${formatSessionCount(session)})`
    )
    lines.push(`         ${sanitizeUntrustedText(session.title)}`)
    lines.push('')
  }
  lines.push('Resume with: coral --session <id>')
  return lines.join('\n')
}

export function formatTuiSessionList(
  sessions: SessionMeta[],
  currentSessionId: string | null
): string
{
  if (sessions.length === 0) return 'No saved sessions.'

  const lines: string[] = [coralHeader('saved sessions'), '']
  for (const session of sessions)
  {
    const isCurrent = session.id === currentSessionId
    const marker = isCurrent ? style('success')(' ●') : '  '
    lines.push(
      `${marker} ${style('user')(cleanSessionId(session))}  ${chalk.white(cleanSessionModel(session))}  ${chalk.dim(formatSessionDate(session))}  ${chalk.dim(`(${formatSessionCount(session)})`)}`
    )
    lines.push(`     ${chalk.dim(sanitizeUntrustedText(session.title))}`)
  }
  lines.push('')
  lines.push(chalk.dim(`Resume with ${style('user')('/resume <id>')}`))
  return lines.join('\n')
}

function formatResumedSession(session: SessionMeta): string
{
  return `Resumed session ${style('user')(cleanSessionId(session))} — ${sanitizeUntrustedText(session.title)}`
}

function formatResumeMatches(matches: SessionMeta[]): string
{
  return matches
    .slice(0, 5)
    .map(
      (session) =>
        `  ${style('user')(cleanSessionId(session))}  ${chalk.dim(sanitizeUntrustedText(session.title))}`
    )
    .join('\n')
}

export function formatTuiResumeResolution(
  resolution: ResumeSessionResolution
): string
{
  switch (resolution.type)
  {
    case 'target':
      return formatResumedSession(resolution.session)
    case 'current':
      return 'Already in this session.'
    case 'unavailable':
      return (
        `Session unavailable: ${style('user')(cleanSessionId(resolution.session))}\n` +
        `Working directory no longer exists: ${sanitizeUntrustedText(resolution.session.cwd)}`
      )
    case 'empty':
      return 'No other sessions to resume.'
    case 'ambiguous':
      return (
        `Ambiguous session ID "${sanitizeUntrustedText(resolution.requestedId)}" — multiple matches:\n` +
        formatResumeMatches(resolution.matches)
      )
    case 'not_found':
      return (
        `Session not found: ${sanitizeUntrustedText(resolution.requestedId)}\n` +
        `Use ${style('user')('/sessions')} to see available sessions.`
      )
  }
}

export function formatCliResumeError(
  resolution: Exclude<ResumeSessionResolution, { type: 'target' }>
): string
{
  switch (resolution.type)
  {
    case 'current':
      return `Session already active: ${cleanSessionId(resolution.session)}`
    case 'unavailable':
      return (
        `Cannot resume session ${cleanSessionId(resolution.session)}.\n` +
        `Working directory no longer exists: ${sanitizeUntrustedText(resolution.session.cwd)}`
      )
    case 'empty':
      return 'No sessions to resume.'
    case 'ambiguous':
      return (
        `Ambiguous session ID "${sanitizeUntrustedText(resolution.requestedId)}" — multiple matches:\n` +
        formatResumeMatches(resolution.matches) +
        '\nUse the full session ID.'
      )
    case 'not_found':
      return (
        `Session not found: ${sanitizeUntrustedText(resolution.requestedId)}\n` +
        'Run coral --sessions to see available sessions.'
      )
  }
}
