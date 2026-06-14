// src/tui/status-line.ts
// status label & separator formatting

import stripAnsi from 'strip-ansi'
import wrapAnsi from 'wrap-ansi'
import type { RunStage } from './run-stage.js'

// truncate an ANSI-styled string to a visible column budget, preserving codes
function truncateToWidth(text: string, width: number): string
{
  if (width <= 0) return ''
  if (stripAnsi(text).length <= width) return text
  return (
    wrapAnsi(text, width, { hard: true, trim: false, wordWrap: false }).split(
      '\n'
    )[0] ?? ''
  )
}

// fixed-label stages; 'idle' & unmapped values fall through to 'ready'
const STAGE_LABELS: Partial<Record<RunStage, string>> = {
  waiting: 'waiting for model',
  thinking: 'thinking',
  responding: 'responding',
  compacting: 'compacting context',
}

export function describeRunStage(stage: RunStage): string
{
  const label = STAGE_LABELS[stage]
  if (label) return label
  if (stage.startsWith('tool:')) return `running ${stage.slice(5)}`
  return 'ready'
}

export function buildStatusLine(
  left: string,
  right: string,
  width: number
): string
{
  const rightVisible = stripAnsi(right).length

  // reserve room for the right segment + a single-space gap, then fit the left
  const leftBudget = Math.max(width - rightVisible - 1, 0)
  const leftFitted = truncateToWidth(left, leftBudget)
  const leftVisible = stripAnsi(leftFitted).length

  const gap = Math.max(width - leftVisible - rightVisible, 1)
  const line = leftFitted + ' '.repeat(gap) + right

  // final guard for very narrow widths where the right segment alone overflows
  return truncateToWidth(line, width)
}

export function buildRule(width: number): string
{
  return '─'.repeat(Math.max(width, 1))
}

export function buildLabeledSeparator(width: number, label: string): string
{
  const labelStr = ` ${label} `
  const remaining = Math.max(width - labelStr.length, 2)
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  return `${'─'.repeat(left)}${labelStr}${'─'.repeat(right)}`
}
