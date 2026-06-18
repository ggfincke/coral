// src/tui/command-output.ts
// shared slash-command & CLI output formatters

import chalk from 'chalk'
import type { CompactionResult } from '../agent/agent.js'
import type { ResumeSessionResolution } from '../session/resume.js'
import type { SessionMeta } from '../session/store.js'
import { formatTokenCount } from './metrics.js'
import { style } from './theme.js'

export function coralHeader(title: string): string
{
  return `${style('primary')('Coral')} ${style('muted')(`— ${title}`)}`
}

function formatSessionDate(session: SessionMeta): string
{
  return new Date(session.updatedAt).toLocaleString()
}

function formatSessionCount(session: SessionMeta): string
{
  return `${session.messageCount} msgs`
}

export function formatCliSessionList(sessions: SessionMeta[]): string
{
  if (sessions.length === 0) return 'No saved sessions.'

  const lines: string[] = [`${sessions.length} saved session(s):`, '']

  for (const session of sessions)
  {
    lines.push(
      `  ${session.id}  ${session.model}  ${formatSessionDate(session)}  (${formatSessionCount(session)})`
    )
    lines.push(`         ${session.title}`)
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
      `${marker} ${style('user')(session.id)}  ${chalk.white(session.model)}  ${chalk.dim(formatSessionDate(session))}  ${chalk.dim(`(${formatSessionCount(session)})`)}`
    )
    lines.push(`     ${chalk.dim(session.title)}`)
  }

  lines.push('')
  lines.push(chalk.dim(`Resume with ${style('user')('/resume <id>')}`))

  return lines.join('\n')
}

function formatResumedSession(session: SessionMeta): string
{
  return `Resumed session ${style('user')(session.id)} — ${session.title}`
}

function formatResumeMatches(matches: SessionMeta[]): string
{
  return matches
    .slice(0, 5)
    .map(
      (session) => `  ${style('user')(session.id)}  ${chalk.dim(session.title)}`
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
    case 'empty':
      return 'No other sessions to resume.'
    case 'ambiguous':
      return (
        `Ambiguous session ID "${resolution.requestedId}" — multiple matches:\n` +
        formatResumeMatches(resolution.matches)
      )
    case 'not_found':
      return (
        `Session not found: ${resolution.requestedId}\n` +
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
      return `Session already active: ${resolution.session.id}`
    case 'empty':
      return 'No sessions to resume.'
    case 'ambiguous':
      return (
        `Ambiguous session ID "${resolution.requestedId}" — multiple matches:\n` +
        formatResumeMatches(resolution.matches) +
        '\nUse the full session ID.'
      )
    case 'not_found':
      return (
        `Session not found: ${resolution.requestedId}\n` +
        'Run coral --sessions to see available sessions.'
      )
  }
}

export function formatManualCompactionResult(result: CompactionResult): string
{
  const savedTokens = result.beforeTokens - result.afterTokens
  const savedMessages = result.beforeMessages - result.afterMessages

  return [
    'Context compacted',
    `  ${result.beforeMessages} messages -> ${result.afterMessages} messages (${savedMessages} summarized)`,
    `  ~${formatTokenCount(result.beforeTokens)} -> ~${formatTokenCount(result.afterTokens)} tokens (${formatTokenCount(savedTokens)} freed)`,
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
  ].join('\n')
}

export function formatPermissionsHelp(yolo: boolean): string
{
  const current = yolo ? 'yolo' : 'ask'
  const description = yolo
    ? 'auto-approve all tool calls'
    : 'prompt before writes & shell commands'

  return (
    `Permission mode: ${chalk.bold(current)} (${description})\n\n` +
    `  ${style('user')('/permissions ask')}   — prompt before writes & shell commands\n` +
    `  ${style('user')('/permissions yolo')}  — auto-approve all tool calls\n` +
    `  ${chalk.dim('ctrl+y')}             — quick toggle`
  )
}

export function formatPermissionModeChange(yolo: boolean): string
{
  return yolo
    ? `Permission mode → ${style('warning').bold('yolo')} (all tool calls auto-approved)`
    : `Permission mode → ${chalk.bold('ask')} (prompt before writes & shell commands)`
}

export function formatUnknownPermissionMode(mode: string): string
{
  return (
    `Unknown permission mode: "${mode}"\n` +
    `Valid modes: ${style('user')('ask')}, ${style('user')('yolo')}`
  )
}
