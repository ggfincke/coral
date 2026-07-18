// src/tui/commands/runtime-output.ts
// format permission, MCP, and theme runtime command output

import chalk from 'chalk'
import type { McpServerStatus, McpStatus } from '../../mcp/types.js'
import { getTheme, style, type Role, type RoleColor } from '../theme.js'
import { THEMES } from '../themes.js'
import { sanitizeUntrustedText } from '../transcript/sanitize.js'
import { coralHeader } from './output.js'

// keep MCP availability copy consistent across status and mode formatters
export function describePermissionMode(yolo: boolean): string
{
  return yolo
    ? 'yolo (auto-approve gated; denies stay blocked; MCP disabled)'
    : 'ask (prompt before writes; MCP available)'
}

export function formatPermissionsHelp(yolo: boolean): string
{
  const current = yolo ? 'yolo' : 'ask'
  const description = yolo
    ? 'auto-approve gated calls; always_deny stays blocked; MCP disabled'
    : 'prompt before writes, shell commands, & MCP tools'
  return (
    `Permission mode: ${chalk.bold(current)} (${description})\n\n` +
    `  ${style('user')('/permissions ask')}   — prompt before gated calls; MCP available\n` +
    `  ${style('user')('/permissions yolo')}  — auto-approve gated calls; MCP unavailable\n` +
    `  ${chalk.dim('ctrl+y')}             — quick toggle`
  )
}

export function formatPermissionModeChange(yolo: boolean): string
{
  return yolo
    ? `Permission mode → ${style('warning').bold('yolo')} (all approval-gated built-in tool calls auto-approved; configured always_deny tools stay blocked; MCP disabled)`
    : `Permission mode → ${chalk.bold('ask')} (prompt before gated calls; MCP starts on the next chat turn)`
}

export function formatPermissionModeUnchanged(yolo: boolean): string
{
  return yolo
    ? `Permission mode is already ${style('warning').bold('yolo')} (MCP disabled)`
    : `Permission mode is already ${chalk.bold('ask')}`
}

export function formatPermissionModeLocked(): string
{
  return 'Permission mode is locked while a turn or command is running.'
}

export function formatUnknownPermissionMode(mode: string): string
{
  return (
    `Unknown permission mode: "${mode}"\n` +
    `Valid modes: ${style('user')('ask')}, ${style('user')('yolo')}`
  )
}

function formatMcpServer(status: McpServerStatus): string[]
{
  const clean = sanitizeUntrustedText
  const configured = status.configuredTools.map(clean).join(', ') || '(none)'
  const available = status.availableTools.map(clean).join(', ') || '(none)'
  const envNames = status.passEnv.map(clean).join(', ') || '(none)'
  const state =
    status.state === 'ready'
      ? style('success')(status.state)
      : status.state === 'configured'
        ? chalk.dim(status.state)
        : style('warning')(status.state)
  const lines = [
    `  ${style('user')(clean(status.alias))}  ${state}`,
    `    Executable: ${status.executable ? clean(status.executable) : '(not resolved)'}`,
    `    Working dir: ${clean(status.launchCwd)}`,
    `    Env names:   ${envNames}`,
    `    Tools:       ${status.state === 'ready' ? available : configured}`,
  ]

  const pushField = (label: string, value: string) =>
  {
    const [first = '', ...rest] = clean(value).split('\n')
    lines.push(`    ${label}${first}`)
    for (const continuation of rest)
    {
      lines.push(`${' '.repeat(17)}${continuation}`)
    }
  }

  if (status.message) pushField('Detail:      ', status.message)
  if (status.stderr) pushField('Stderr:      ', status.stderr)
  return lines
}

export function formatMcpStatus(status: McpStatus, yolo: boolean): string
{
  const lines = [coralHeader('MCP status'), '']
  if (yolo)
  {
    lines.push(
      style('warning')('  MCP is disabled in yolo mode.'),
      chalk.dim(
        '  Switch to ask; configured servers start on the next chat turn.'
      )
    )
  }

  for (const issue of status.configIssues)
  {
    const server = issue.server
      ? `${sanitizeUntrustedText(issue.server)}: `
      : ''
    lines.push(
      style('warning')(
        `  Config issue: ${server}${sanitizeUntrustedText(issue.message)}`
      )
    )
  }
  if (status.servers.length === 0)
  {
    if (status.configIssues.length === 0)
    {
      lines.push(chalk.dim('  No MCP servers are configured in ~/.coral.json.'))
    }
    return lines.join('\n')
  }

  if (yolo) lines.push('')
  for (const [index, server] of status.servers.entries())
  {
    if (index > 0) lines.push('')
    lines.push(...formatMcpServer(server))
  }
  lines.push('', chalk.dim('  Config changes require a new Coral session.'))
  return lines.join('\n')
}

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
