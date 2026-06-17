// src/tui/approval-box.ts
// bordered tool approval prompt formatting

import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import wrapAnsi from 'wrap-ansi'
import { renderUnifiedDiff } from './diff.js'
import { summarizeToolArgs } from './transcript.js'
import { buildLabeledSeparator, buildRule } from './status-line.js'
import { style } from './theme.js'

// cap the change preview so large edits don't swallow the screen
const MAX_PREVIEW_LINES = 20

function formatApprovalArgs(
  toolName: string,
  args: Record<string, unknown>
): string
{
  const summary = summarizeToolArgs(toolName, args)
  return toolName === 'bash' ? `$ ${summary}` : summary
}

// lines come back fully styled — render w/o an outer Ink color prop so the
// embedded diff colors survive
export function buildApprovalBox(
  toolName: string,
  args: Record<string, unknown>,
  width: number,
  diff?: string
): string[]
{
  const warn = style('warning')
  const innerWidth = Math.max(width - 4, 12)
  const summary = formatApprovalArgs(toolName, args)
  const title = `Allow ${toolName}?`

  // pad by visible length — styled content carries ANSI codes
  const row = (content: string): string =>
  {
    const fill = ' '.repeat(Math.max(innerWidth - stripAnsi(content).length, 0))
    return `${warn('│')} ${content}${fill} ${warn('│')}`
  }

  const lines: string[] = [
    warn(`╭─${buildLabeledSeparator(innerWidth, 'tool approval')}─╮`),
    row(''),
    row(warn(title)),
  ]

  const wrapped = wrapAnsi(summary, innerWidth, {
    hard: true,
    trim: false,
    wordWrap: true,
  })
  for (const summaryLine of wrapped.split('\n'))
  {
    lines.push(row(warn(summaryLine)))
  }

  if (diff)
  {
    lines.push(row(''))
    const rendered = renderUnifiedDiff(diff, innerWidth)
    for (const diffLine of rendered.slice(0, MAX_PREVIEW_LINES))
    {
      lines.push(row(diffLine))
    }
    if (rendered.length > MAX_PREVIEW_LINES)
    {
      lines.push(
        row(chalk.dim(`… +${rendered.length - MAX_PREVIEW_LINES} more lines`))
      )
    }
  }

  lines.push(row(''))
  lines.push(row(warn('(y) approve  (n) reject  (esc) cancel')))
  lines.push(row(''))
  lines.push(warn(`╰${buildRule(innerWidth + 2)}╯`))

  return lines
}

// bordered yes/no prompt — reused for the doom-loop pause
export function buildConfirmBox(
  message: string,
  width: number,
  label = 'confirm'
): string[]
{
  const warn = style('warning')
  const innerWidth = Math.max(width - 4, 12)

  const row = (content: string): string =>
  {
    const fill = ' '.repeat(Math.max(innerWidth - stripAnsi(content).length, 0))
    return `${warn('│')} ${content}${fill} ${warn('│')}`
  }

  const lines: string[] = [
    warn(`╭─${buildLabeledSeparator(innerWidth, label)}─╮`),
    row(''),
  ]

  const wrapped = wrapAnsi(message, innerWidth, {
    hard: true,
    trim: false,
    wordWrap: true,
  })
  for (const line of wrapped.split('\n'))
  {
    lines.push(row(warn(line)))
  }

  lines.push(row(''))
  lines.push(row(warn('(y) continue  (n) stop')))
  lines.push(row(''))
  lines.push(warn(`╰${buildRule(innerWidth + 2)}╯`))

  return lines
}
