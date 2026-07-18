// src/tui/palette/palette.ts
// command palette entries, ranking, and terminal-line rendering

import chalk from 'chalk'
import { style } from '../theme.js'
import { wrapLines } from '../wrap.js'
import type { CommandInfo } from '../commands/contracts.js'
import type {
  KeybindingAction,
  KeybindingSummary,
} from '../input/keybindings.js'

export type PaletteEntryKind = 'command' | 'keybinding'

export interface PaletteEntry
{
  id: string
  kind: PaletteEntryKind
  title: string
  detail: string
  keywords: string[]
  command?: string
  keybinding?: string
  action?: KeybindingAction
}

export interface PaletteLinesOptions
{
  entries: PaletteEntry[]
  query: string
  selectedIndex: number
  width: number
  height: number
}

export interface PaletteInputState
{
  query: string
  selectedIndex: number
}

export interface PaletteInputKey
{
  upArrow?: boolean
  downArrow?: boolean
  backspace?: boolean
  delete?: boolean
  ctrl?: boolean
  meta?: boolean
}

export interface PaletteInputResult
{
  handled: boolean
  state: PaletteInputState
}

const MAX_VISIBLE_ENTRIES = 10

function scoreText(value: string, query: string): number
{
  const lower = value.toLowerCase()
  if (!query) return 0
  if (lower === query) return 0
  if (lower.startsWith(query)) return 1
  if (lower.includes(query)) return 2
  if (query.length < 3) return Number.POSITIVE_INFINITY

  let index = 0
  for (const char of query)
  {
    index = lower.indexOf(char, index)
    if (index === -1) return Number.POSITIVE_INFINITY
    index++
  }
  return 3
}

function scoreEntry(entry: PaletteEntry, query: string): number
{
  const scores = [entry.title, entry.detail, ...entry.keywords].map((part) =>
    scoreText(part, query)
  )
  return Math.min(...scores)
}

export function buildPaletteEntries(
  commands: CommandInfo[],
  keybindings: KeybindingSummary[]
): PaletteEntry[]
{
  const commandEntries = commands.map((command) => ({
    id: `command:${command.name}`,
    kind: 'command' as const,
    title: `/${command.name}`,
    detail: command.description,
    keywords: [command.name, ...command.aliases, command.description],
    command: `/${command.name}`,
  }))

  const keybindingEntries = keybindings.map((binding) => ({
    id: `key:${binding.keys}`,
    kind: 'keybinding' as const,
    title: binding.keys,
    detail: binding.description,
    keywords: [binding.keys, binding.description],
    keybinding: binding.keys,
    action: binding.action,
  }))

  return [...commandEntries, ...keybindingEntries]
}

export function filterPaletteEntries(
  entries: PaletteEntry[],
  query: string
): PaletteEntry[]
{
  const normalized = query.trim().toLowerCase()
  if (!normalized) return entries.slice(0, MAX_VISIBLE_ENTRIES)

  return entries
    .map((entry, index) => ({
      entry,
      index,
      score: scoreEntry(entry, normalized),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.entry.kind.localeCompare(b.entry.kind) ||
        a.index - b.index
    )
    .slice(0, MAX_VISIBLE_ENTRIES)
    .map((item) => item.entry)
}

export function movePaletteSelection(
  current: number,
  delta: number,
  count: number
): number
{
  if (count <= 0) return 0
  return Math.min(Math.max(current + delta, 0), count - 1)
}

export function reducePaletteInput(
  state: PaletteInputState,
  input: string,
  key: PaletteInputKey,
  matchCount: number
): PaletteInputResult
{
  if (key.upArrow)
  {
    return {
      handled: true,
      state: {
        ...state,
        selectedIndex: movePaletteSelection(
          state.selectedIndex,
          -1,
          matchCount
        ),
      },
    }
  }

  if (key.downArrow)
  {
    return {
      handled: true,
      state: {
        ...state,
        selectedIndex: movePaletteSelection(state.selectedIndex, 1, matchCount),
      },
    }
  }

  if (key.backspace || key.delete)
  {
    return {
      handled: true,
      state: {
        query: state.query.slice(0, -1),
        selectedIndex: 0,
      },
    }
  }

  if (!key.ctrl && !key.meta && input.length === 1 && input >= ' ')
  {
    return {
      handled: true,
      state: {
        query: state.query + input,
        selectedIndex: 0,
      },
    }
  }

  return { handled: false, state }
}

function formatEntry(
  entry: PaletteEntry,
  selected: boolean,
  width: number
): string[]
{
  const marker = selected ? style('accent')('›') : chalk.dim(' ')
  const title = selected
    ? style('accent').bold(entry.title)
    : style('user')(entry.title)
  const detail = chalk.dim(entry.detail)
  const disabled = entry.kind === 'keybinding' && !entry.action
  const suffix = disabled ? chalk.dim(' · press key') : ''
  return wrapLines(
    ` ${marker} ${title}  ${detail}${suffix}`,
    Math.max(width - 2, 20),
    '   '
  )
}

export function buildPaletteLines(opts: PaletteLinesOptions): string[]
{
  const width = Math.max(opts.width, 24)
  const height = Math.max(opts.height, 4)
  const query = opts.query.trim()
  const lines: string[] = [
    `${style('primary').bold('command palette')} ${chalk.dim('ctrl+p')}`,
    chalk.dim(query ? `query: ${query}` : 'type to filter, enter to run'),
    '',
  ]

  if (opts.entries.length === 0)
  {
    lines.push(chalk.dim('  no matches'))
    return lines.slice(0, height)
  }

  const availableHeight = height - lines.length
  const selectedIndex = Math.min(
    Math.max(opts.selectedIndex, 0),
    opts.entries.length - 1
  )
  const formattedEntries = opts.entries.map((entry, index) =>
    formatEntry(entry, index === selectedIndex, width)
  )

  let startIndex = 0
  let usedHeight = formattedEntries
    .slice(0, selectedIndex + 1)
    .reduce((total, entryLines) => total + entryLines.length, 0)

  while (usedHeight > availableHeight && startIndex < selectedIndex)
  {
    usedHeight -= formattedEntries[startIndex]!.length
    startIndex++
  }

  let endIndex = selectedIndex + 1
  while (
    endIndex < formattedEntries.length &&
    usedHeight + formattedEntries[endIndex]!.length <= availableHeight
  )
  {
    usedHeight += formattedEntries[endIndex]!.length
    endIndex++
  }

  const visibleLines = formattedEntries
    .slice(startIndex, endIndex)
    .flat()
    .slice(0, availableHeight)
  lines.push(...visibleLines)
  return lines
}
