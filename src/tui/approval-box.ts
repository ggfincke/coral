// src/tui/approval-box.ts
// bordered tool approval prompt formatting

import wrapAnsi from 'wrap-ansi'
import { summarizeToolArgs } from './transcript.js'
import { buildLabeledSeparator, buildRule } from './status-line.js'

export function formatApprovalArgs(
  toolName: string,
  args: Record<string, unknown>
): string
{
  const summary = summarizeToolArgs(toolName, args)
  return toolName === 'bash' ? `$ ${summary}` : summary
}

export function buildApprovalBox(
  toolName: string,
  args: Record<string, unknown>,
  width: number
): string[]
{
  const innerWidth = Math.max(width - 4, 12)
  const summary = formatApprovalArgs(toolName, args)
  const title = `Allow ${toolName}?`

  const topBorder = `╭─${buildLabeledSeparator(innerWidth, 'tool approval')}─╮`
  const bottomBorder = `╰${buildRule(innerWidth + 2)}╯`
  const emptyLine = `│ ${' '.repeat(innerWidth)} │`

  const lines: string[] = [topBorder, emptyLine]

  const titlePadded = title + ' '.repeat(Math.max(innerWidth - title.length, 0))
  lines.push(`│ ${titlePadded} │`)

  const wrapped = wrapAnsi(summary, innerWidth, {
    hard: true,
    trim: false,
    wordWrap: true,
  })
  for (const summaryLine of wrapped.split('\n'))
  {
    const padded =
      summaryLine + ' '.repeat(Math.max(innerWidth - summaryLine.length, 0))
    lines.push(`│ ${padded} │`)
  }

  lines.push(emptyLine)

  const hint = '(y) approve  (n) reject  (esc) cancel'
  const hintPadded = hint + ' '.repeat(Math.max(innerWidth - hint.length, 0))
  lines.push(`│ ${hintPadded} │`)

  lines.push(emptyLine)
  lines.push(bottomBorder)

  return lines
}
