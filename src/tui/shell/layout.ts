// src/tui/shell/layout.ts
// fit workspace chrome and activity into physical terminal rows

import chalk from 'chalk'
import { basename } from 'node:path'
import { homedir } from 'node:os'
import wrapAnsi from 'wrap-ansi'
import { style } from '../theme.js'
import { sanitizeUntrustedText } from '../transcript/sanitize.js'
import { padEnd, truncateLine, visibleWidth } from '../wrap.js'

export interface HeaderOptions
{
  cwd: string
  model: string
  yolo: boolean
  width: number
}

export function buildHeaderLine(opts: HeaderOptions): string
{
  const width = Math.max(opts.width, 1)
  const permission = opts.yolo
    ? style('warning').bold('[YOLO]')
    : style('user')('[ask]')
  const brand = style('primary').bold('coral')
  const modelBudget = Math.max(width - visibleWidth(permission) - 15, 0)
  const model = truncateLine(
    sanitizeUntrustedText(opts.model || 'pick a model').replace(/\s+/gu, ' '),
    Math.min(modelBudget, Math.floor(width * 0.4))
  )
  const right = model ? `${style('muted')(model)}  ${permission}` : permission
  const leftBudget = Math.max(width - visibleWidth(right) - 2, 0)
  const cwd = sanitizeUntrustedText(opts.cwd).replace(/\s+/gu, ' ')
  const home = homedir()
  const shortened =
    cwd === home
      ? '~'
      : cwd.startsWith(`${home}/`)
        ? `~${cwd.slice(home.length)}`
        : cwd
  const pathBudget = Math.max(leftBudget - 7, 0)
  const workspace =
    visibleWidth(shortened) <= pathBudget
      ? shortened
      : truncateLine(basename(cwd) || cwd, pathBudget)
  const left = truncateLine(
    workspace ? `${brand}  ${chalk.bold(workspace)}` : brand,
    leftBudget
  )
  return truncateLine(
    padEnd(left, Math.max(width - visibleWidth(right), 0)) + right,
    width,
    ''
  )
}

// activity never loses its tail to a long shortcut; the hint gets another row
export function buildActivityLines(
  activity: string,
  hint: string,
  width: number
): string[]
{
  const budget = Math.max(width, 1)
  if (visibleWidth(activity) + visibleWidth(hint) + 2 <= budget)
  {
    return [
      padEnd(activity, budget - visibleWidth(hint)) + style('muted')(hint),
    ]
  }
  const rows = wrapAnsi(activity, budget, {
    hard: true,
    trim: false,
    wordWrap: true,
  }).split('\n')
  if (hint) rows.push(style('muted')(truncateLine(hint, budget)))
  return rows
}

export function buildComposerRule(width: number, label: string): string
{
  const title = truncateLine(label, Math.max(width - 5, 0))
  return (
    style('muted')('╭─ ') +
    style('user')(title) +
    style('muted')(
      ` ${'─'.repeat(Math.max(width - visibleWidth(title) - 5, 0))}╮`
    )
  )
}
