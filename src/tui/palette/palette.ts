// src/tui/palette/palette.ts
// command palette entries, ranking, and terminal-line rendering

import chalk from 'chalk'
import { selectionStyle, style } from '../theme.js'
import { sanitizeUntrustedText } from '../transcript/sanitize.js'
import { padEnd, truncateLine, visibleWidth } from '../wrap.js'
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

// preserve the complete filter while keeping its newest text visible
export function formatPickerQuery(
  query: string,
  width: number,
  placeholder: string
): string
{
  const clean = sanitizeUntrustedText(query).replace(/\s+/g, ' ').trim()
  if (!clean) return chalk.dim(truncateLine(placeholder, width))
  const full = `query: ${clean}`
  if (visibleWidth(full) <= width) return chalk.dim(full)
  const tail = Array.from(clean).slice(-Math.max(width, 1))
  while (tail.length > 0 && visibleWidth(`query: …${tail.join('')}`) > width)
  {
    tail.shift()
  }
  return chalk.dim(truncateLine(`query: …${tail.join('')}`, width))
}

function formatEntry(
  entry: PaletteEntry,
  selected: boolean,
  width: number
): string
{
  const clean = (text: string) =>
    sanitizeUntrustedText(text).replace(/\s+/g, ' ').trim()
  const marker = selected ? '›' : ' '
  const title = selected ? chalk.bold(clean(entry.title)) : clean(entry.title)
  const detail = selected ? clean(entry.detail) : chalk.dim(clean(entry.detail))
  const disabled = entry.kind === 'keybinding' && !entry.action
  const suffix = disabled
    ? selected
      ? ' · press key'
      : chalk.dim(' · press key')
    : ''
  const row = truncateLine(` ${marker} ${title}${suffix}  ${detail}`, width)
  return selected ? selectionStyle()(padEnd(row, width)) : row
}

export function buildPaletteLines(opts: PaletteLinesOptions): string[]
{
  const width = Math.max(Math.floor(opts.width), 0)
  const height = Math.max(Math.floor(opts.height), 0)
  if (width === 0 || height === 0) return []
  const lines: string[] = []
  if (height >= 2)
    lines.push(
      `${style('primary').bold('command palette')} ${chalk.dim('ctrl+p')}`
    )
  if (height >= 3)
    lines.push(
      formatPickerQuery(
        opts.query,
        width,
        'type to filter · enter to run · esc cancels'
      )
    )
  if (height >= 6) lines.push('')

  if (opts.entries.length === 0)
  {
    lines.push(chalk.dim('  no matches'))
    return lines.slice(0, height).map((line) => truncateLine(line, width))
  }

  const availableHeight = height - lines.length
  const selectedIndex = Math.min(
    Math.max(opts.selectedIndex, 0),
    opts.entries.length - 1
  )
  const detailRows = availableHeight >= 5 ? 2 : 0
  const listRows = availableHeight - detailRows
  const start = Math.min(
    Math.max(selectedIndex - Math.floor(listRows / 2), 0),
    Math.max(opts.entries.length - listRows, 0)
  )
  const end = Math.min(start + listRows, opts.entries.length)
  for (let index = start; index < end; index++)
  {
    lines.push(
      formatEntry(opts.entries[index]!, index === selectedIndex, width)
    )
  }
  if (detailRows)
  {
    const selected = opts.entries[selectedIndex]!
    lines.push(
      '',
      chalk.dim(
        sanitizeUntrustedText(selected.detail).replace(/\s+/g, ' ').trim()
      )
    )
  }
  return lines.slice(0, height).map((line) => truncateLine(line, width))
}
