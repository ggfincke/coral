// src/tui/transcript/backtrack.ts
// esc-esc backtrack turns, previews, and selector line rendering

import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import { style } from '../theme.js'
import { sanitizeUntrustedText } from './sanitize.js'
import type { OllamaMessage } from '../../types/inference.js'
import { findUserTurnStarts, type UndoTurn } from '../../types/undo.js'

const PREVIEW_MAX_CHARS = 80
// rows jumped by pageUp/pageDown in the selector
const PAGE_ROWS = 10

export interface BacktrackTurn
{
  // conversation-message index of the user message that starts this turn
  startIndex: number
  content: string
}

export interface BacktrackLinesOptions
{
  turns: BacktrackTurn[]
  selectedIndex: number
  width: number
  height: number
}

export interface BacktrackInputState
{
  selectedIndex: number
}

export interface BacktrackInputKey
{
  upArrow?: boolean
  downArrow?: boolean
  pageUp?: boolean
  pageDown?: boolean
}

export interface BacktrackInputResult
{
  handled: boolean
  state: BacktrackInputState
}

// list restorable turns oldest-first; displayContent keeps the raw prompt
// when attachment expansion rewrote the stored content
export function buildBacktrackTurns(
  messages: readonly OllamaMessage[],
  undo: readonly UndoTurn[] = []
): BacktrackTurn[]
{
  const turns: BacktrackTurn[] = []
  for (const index of findUserTurnStarts(messages, undo))
  {
    const message = messages[index]!
    turns.push({
      startIndex: index,
      content: message.displayContent ?? message.content,
    })
  }
  return turns
}

// collapse a stored prompt into one bounded selector row
export function previewBacktrackTurn(content: string): string
{
  const flat = sanitizeUntrustedText(content).replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_MAX_CHARS
    ? `${flat.slice(0, PREVIEW_MAX_CHARS - 1)}…`
    : flat
}

export function moveBacktrackSelection(
  current: number,
  delta: number,
  count: number
): number
{
  if (count <= 0) return 0
  return Math.min(Math.max(current + delta, 0), count - 1)
}

export function reduceBacktrackInput(
  state: BacktrackInputState,
  key: BacktrackInputKey,
  count: number,
  pageSize = PAGE_ROWS
): BacktrackInputResult
{
  const delta = key.upArrow
    ? -1
    : key.downArrow
      ? 1
      : key.pageUp
        ? -pageSize
        : key.pageDown
          ? pageSize
          : 0
  if (delta === 0) return { handled: false, state }

  return {
    handled: true,
    state: {
      selectedIndex: moveBacktrackSelection(state.selectedIndex, delta, count),
    },
  }
}

function formatTurnRow(
  turn: BacktrackTurn,
  selected: boolean,
  width: number
): string[]
{
  const marker = selected ? style('accent')('›') : chalk.dim(' ')
  const preview = previewBacktrackTurn(turn.content)
  const text = selected ? style('accent').bold(preview) : style('user')(preview)
  return wrapAnsi(` ${marker} ${text}`, Math.max(width - 5, 1), {
    hard: true,
    trim: false,
    wordWrap: true,
  })
    .split('\n')
    .map((line) => `   ${line}`)
}

export function buildBacktrackLines(opts: BacktrackLinesOptions): string[]
{
  const width = Math.max(opts.width, 24)
  const height = Math.max(opts.height, 4)
  const lines: string[] = [
    `${style('primary').bold('backtrack')} ${chalk.dim('rewind to an earlier prompt')}`,
    chalk.dim('enter restores · esc cancels'),
    '',
  ]

  if (opts.turns.length === 0)
  {
    lines.push(chalk.dim('  no earlier prompts'))
    return lines.slice(0, height)
  }

  const selectedIndex = Math.min(
    Math.max(opts.selectedIndex, 0),
    opts.turns.length - 1
  )
  const formattedRows = opts.turns.map((turn) =>
    formatTurnRow(turn, turn === opts.turns[selectedIndex], width)
  )

  // keep the selected row visible in short viewports
  const availableHeight = Math.max(height - lines.length, 1)
  let startIndex = 0
  let usedHeight = formattedRows
    .slice(0, selectedIndex + 1)
    .reduce((total, row) => total + row.length, 0)
  while (usedHeight > availableHeight && startIndex < selectedIndex)
  {
    usedHeight -= formattedRows[startIndex]!.length
    startIndex++
  }

  let endIndex = selectedIndex + 1
  while (
    endIndex < formattedRows.length &&
    usedHeight + formattedRows[endIndex]!.length <= availableHeight
  )
  {
    usedHeight += formattedRows[endIndex]!.length
    endIndex++
  }

  for (let index = startIndex; index < endIndex; index++)
  {
    lines.push(...formattedRows[index]!)
  }
  return lines.slice(0, height)
}
