// src/tui/approval-box.ts
// bordered tool approval prompt formatting

import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import { renderUnifiedDiff } from './diff.js'
import { summarizeToolArgs } from './transcript.js'
import { boxFrame } from './status-line.js'
import { style } from './theme.js'
import { sanitizeUntrustedText } from './sanitize.js'

// cap change previews so large edits don't swallow the screen
const MAX_PREVIEW_LINES = 20

interface PromptBoxBuilder
{
  innerWidth: number
  lines: string[]
  row: (content: string) => string
  warn: (content: string) => string
  pushWrapped: (content: string, decorate?: (line: string) => string) => void
  finish: (actionLine: string) => string[]
}

function formatApprovalArgs(
  toolName: string,
  args: Record<string, unknown>
): string
{
  const summary = summarizeToolArgs(toolName, args)
  return toolName === 'bash' ? `$ ${summary}` : summary
}

function createPromptBox(width: number, label: string): PromptBoxBuilder
{
  const warn = style('warning')
  const frame = boxFrame(width, label, warn)

  const lines: string[] = [frame.top, frame.row('')]

  const pushWrapped = (
    content: string,
    decorate: (line: string) => string = (line) => line
  ) =>
  {
    const wrapped = wrapAnsi(content, frame.innerWidth, {
      hard: true,
      trim: false,
      wordWrap: true,
    })
    for (const line of wrapped.split('\n'))
    {
      lines.push(frame.row(decorate(line)))
    }
  }

  const finish = (actionLine: string): string[] =>
  {
    lines.push(frame.row(''))
    lines.push(frame.row(actionLine))
    lines.push(frame.row(''))
    lines.push(frame.bottom)

    return lines
  }

  return {
    innerWidth: frame.innerWidth,
    lines,
    row: frame.row,
    warn,
    pushWrapped,
    finish,
  }
}

// lines come back fully styled; render w/o an outer Ink color prop so the
// embedded diff colors survive
export function buildApprovalBox(
  toolName: string,
  args: Record<string, unknown>,
  width: number,
  diff?: string,
  previewMessage?: string
): string[]
{
  const box = createPromptBox(width, 'tool approval')
  const summary = formatApprovalArgs(toolName, args)
  const title = `Allow ${toolName}?`

  box.lines.push(box.row(box.warn(title)))
  box.pushWrapped(summary, box.warn)

  if (diff)
  {
    box.lines.push(box.row(''))
    const rendered = renderUnifiedDiff(diff, box.innerWidth)
    for (const diffLine of rendered.slice(0, MAX_PREVIEW_LINES))
    {
      box.lines.push(box.row(diffLine))
    }
    if (rendered.length > MAX_PREVIEW_LINES)
    {
      box.lines.push(
        box.row(
          chalk.dim(`… +${rendered.length - MAX_PREVIEW_LINES} more lines`)
        )
      )
    }
  }
  else if (previewMessage)
  {
    box.lines.push(box.row(''))
    box.pushWrapped(chalk.dim(sanitizeUntrustedText(previewMessage)))
  }

  return box.finish(box.warn('(y) approve  (n) reject  (esc) cancel'))
}

// bordered yes/no prompt reused for the doom-loop pause
export function buildConfirmBox(
  message: string,
  width: number,
  label = 'confirm'
): string[]
{
  const box = createPromptBox(width, label)
  box.pushWrapped(sanitizeUntrustedText(message), box.warn)
  return box.finish(box.warn('(y) continue  (n) stop'))
}
