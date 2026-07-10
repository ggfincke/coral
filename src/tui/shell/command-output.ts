// src/tui/shell/command-output.ts
// shared slash-command & CLI output formatters

import chalk from 'chalk'
import type { CompactionResult } from '../../agent/agent.js'
import type { ResumeSessionResolution } from '../../session/resume.js'
import type { SessionMeta } from '../../session/store.js'
import type { IndexStats } from '../../retrieval/types.js'
import type { TodoItem } from '../../tools/todo-store.js'
import { isMissingModelError, withPullHint } from '../../utils/errors.js'
import { formatTokenCount } from './metrics.js'
import { getTheme, style, type Role, type RoleColor } from '../theme.js'
import { THEMES } from '../themes.js'
import { strikeIfDone, todoRowText } from '../transcript/todo-panel.js'
import { sanitizeUntrustedText } from '../transcript/sanitize.js'

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

export function formatPermissionsHelp(yolo: boolean): string
{
  const current = yolo ? 'yolo' : 'ask'
  const description = yolo
    ? 'auto-approve gated calls; always_deny stays blocked'
    : 'prompt before writes & shell commands'

  return (
    `Permission mode: ${chalk.bold(current)} (${description})\n\n` +
    `  ${style('user')('/permissions ask')}   — prompt before writes & shell commands\n` +
    `  ${style('user')('/permissions yolo')}  — auto-approve gated calls; denies stay blocked\n` +
    `  ${chalk.dim('ctrl+y')}             — quick toggle`
  )
}

export function formatPermissionModeChange(yolo: boolean): string
{
  return yolo
    ? `Permission mode → ${style('warning').bold('yolo')} (all tool calls auto-approved) — applies only to approval-gated tools; configured always_deny tools stay blocked`
    : `Permission mode → ${chalk.bold('ask')} (prompt before writes & shell commands)`
}

export function formatUnknownPermissionMode(mode: string): string
{
  return (
    `Unknown permission mode: "${mode}"\n` +
    `Valid modes: ${style('user')('ask')}, ${style('user')('yolo')}`
  )
}

// ── /index ─────────────────────────────────────────────────────────────

export function formatIndexStart(cwd: string, force: boolean): string
{
  return force
    ? `Rebuilding semantic index for ${chalk.dim(cwd)}…`
    : `Indexing ${chalk.dim(cwd)}…`
}

export function formatIndexProgress(processed: number, total: number): string
{
  return chalk.dim(`  embedded ${processed}/${total} files`)
}

export function formatIndexResult(stats: IndexStats): string
{
  if (stats.totalFiles === 0) return 'No indexable files found'
  if (stats.embeddedFiles === 0)
  {
    return `Index already up to date (${stats.totalFiles} files)`
  }
  return `Indexed ${stats.embeddedFiles}/${stats.totalFiles} files · ${stats.chunks} chunks`
}

export function formatIndexError(
  embeddingModel: string,
  message: string
): string
{
  const base = `Index build failed (embedding model ${embeddingModel}): ${message}`
  if (!isMissingModelError(message)) return base
  return withPullHint(base, embeddingModel, '\n')
}

// ── /theme ─────────────────────────────────────────────────────────────

// colored swatch dot rendered in a specific theme's own palette
function swatch(color: RoleColor): string
{
  return 'ansi' in color
    ? chalk[color.ansi]('●')
    : chalk.rgb(color.r, color.g, color.b)('●')
}

const SWATCH_ROLES: Role[] = ['primary', 'accent', 'user', 'code', 'muted']

export function formatThemeList(): string
{
  const current = getTheme()
  const maxName = Math.max(...THEMES.map((theme) => theme.name.length))
  const lines: string[] = [coralHeader('themes'), '']

  for (const theme of THEMES)
  {
    const dots = SWATCH_ROLES.map((role) => swatch(theme.roles[role])).join(' ')
    const marker = theme === current ? style('primary')('›') : ' '
    lines.push(
      `${marker} ${dots}  ${theme.name.padEnd(maxName)}  ${chalk.dim(theme.description)}`
    )
  }

  lines.push('')
  lines.push(chalk.dim(`Switch with ${style('user')('/theme <name>')}`))
  return lines.join('\n')
}

// ── /todo ──────────────────────────────────────────────────────────────

export function formatTodoList(todos: TodoItem[]): string
{
  const lines: string[] = [coralHeader('tasks'), '']
  for (const todo of todos)
  {
    lines.push(`  ${strikeIfDone(todo, todoRowText(todo))}`)
  }
  return lines.join('\n')
}
