// src/tui/diff.ts
// render unified diff text into colored terminal lines w/ a line-number gutter

import chalk from 'chalk'
import { style } from './theme.js'
import { sanitizeUntrustedText } from './sanitize.js'

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// file-level lines from git output — styled w/o gutter & never counted
function isFileHeader(line: string): boolean
{
  return (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode')
  )
}

// widest line number across all hunks -> gutter column width
function gutterWidth(lines: string[]): number
{
  let max = 0
  for (const line of lines)
  {
    const match = HUNK_HEADER.exec(line)
    if (!match) continue
    const oldEnd = Number(match[1]) + Number(match[2] ?? 1)
    const newEnd = Number(match[3]) + Number(match[4] ?? 1)
    max = Math.max(max, oldEnd, newEnd)
  }
  return Math.max(String(max).length, 2)
}

// truncate raw text to fit, marking the cut w/ an ellipsis
function fitContent(
  raw: string,
  maxWidth: number
): { text: string; cut: boolean }
{
  if (raw.length <= maxWidth) return { text: raw, cut: false }
  return { text: raw.slice(0, Math.max(maxWidth - 1, 1)), cut: true }
}

// render unified diff text (single-file tool diffs or full git output) into
// styled lines: dim two-column gutter, +/- sign, themed add/remove colors
export function renderUnifiedDiff(unified: string, width: number): string[]
{
  const rawLines = sanitizeUntrustedText(unified).split('\n')
  const numWidth = gutterWidth(rawLines)
  const gutterCols = numWidth * 2 + 1
  const contentWidth = Math.max(width - gutterCols - 1, 8)
  const blankNum = ' '.repeat(numWidth)
  // pad a line number into the gutter column
  const num = (n: number) => String(n).padStart(numWidth)

  let oldLine = 0
  let newLine = 0
  const result: string[] = []

  for (const raw of rawLines)
  {
    const hunk = HUNK_HEADER.exec(raw)
    if (hunk)
    {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      result.push(style('code')(raw))
      continue
    }

    if (isFileHeader(raw))
    {
      result.push(chalk.bold(raw))
      continue
    }

    let gutter: string
    let colorize: (text: string) => string

    if (raw.startsWith('+'))
    {
      gutter = `${blankNum} ${num(newLine++)}`
      colorize = style('success')
    }
    else if (raw.startsWith('-'))
    {
      gutter = `${num(oldLine++)} ${blankNum}`
      colorize = style('error')
    }
    else if (raw.startsWith(' ') || raw === '')
    {
      gutter = `${num(oldLine++)} ${num(newLine++)}`
      colorize = chalk.dim
    }
    else
    {
      // "\ No newline at end of file", truncation markers, & friends
      result.push(chalk.dim(raw))
      continue
    }

    const { text, cut } = fitContent(raw, contentWidth)
    result.push(
      `${chalk.dim(gutter)} ${colorize(text)}${cut ? chalk.dim('…') : ''}`
    )
  }

  return result
}
