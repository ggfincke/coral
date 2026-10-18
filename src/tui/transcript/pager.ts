// src/tui/transcript/pager.ts
// pure state, search, and footer helpers for the full-screen transcript pager

import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import type { CoralKey } from '../input/terminal-input.js'
import { previousGraphemeOffset } from '../prompt/grapheme.js'
import { selectionStyle } from '../theme.js'
import { sanitizeUntrustedText } from './sanitize.js'
import { truncateLine, visibleWidth } from '../wrap.js'

export interface PagerState
{
  // index of the first visible row
  readonly top: number
  // committed search query; empty means no search
  readonly query: string
  // query being typed, or null while browsing
  readonly draft: string | null
  // row of the current match, or null when none is selected
  readonly current: number | null
}

export interface PagerView
{
  readonly total: number
  readonly bodyHeight: number
  // rows matching a query, computed by the owner over the stripped rows
  readonly matchesFor: (query: string) => readonly number[]
}

export interface PagerStep
{
  readonly state: PagerState
  readonly close?: true
  readonly interrupt?: true
}

export type PagerKey = Pick<
  CoralKey,
  | 'ctrl'
  | 'meta'
  | 'tab'
  | 'return'
  | 'escape'
  | 'backspace'
  | 'delete'
  | 'upArrow'
  | 'downArrow'
  | 'pageUp'
  | 'pageDown'
  | 'home'
  | 'end'
  | 'wheelUp'
  | 'wheelDown'
>

const WHEEL_ROWS = 3

export function maxPagerTop(total: number, bodyHeight: number): number
{
  return Math.max(total - bodyHeight, 0)
}

// the pager opens pinned to the newest rows, like the live viewport
export function initialPagerState(
  total: number,
  bodyHeight: number
): PagerState
{
  return {
    top: maxPagerTop(total, bodyHeight),
    query: '',
    draft: null,
    current: null,
  }
}

function clampTop(top: number, view: PagerView): number
{
  return Math.min(Math.max(top, 0), maxPagerTop(view.total, view.bodyHeight))
}

// stripped, lowercased rows are the search corpus; row index == display row
export function plainRow(row: string): string
{
  return stripAnsi(row).toLowerCase()
}

const PLAIN_ROWS_CACHE = new WeakMap<readonly string[], readonly string[]>()

// committed rows keep their array identity across ticks, so strip them once
export function plainRowsFor(rows: readonly string[]): readonly string[]
{
  const cached = PLAIN_ROWS_CACHE.get(rows)
  if (cached) return cached
  const plain = rows.map(plainRow)
  PLAIN_ROWS_CACHE.set(rows, plain)
  return plain
}

export function findMatchRows(
  plainRows: readonly string[],
  query: string
): number[]
{
  const needle = query.toLowerCase()
  if (!needle) return []
  const matches: number[] = []
  for (let i = 0; i < plainRows.length; i++)
  {
    if (plainRows[i]!.includes(needle)) matches.push(i)
  }
  return matches
}

// bring a row into view w/ a third of the body above it, less-style
function revealRow(row: number, state: PagerState, view: PagerView): number
{
  if (row >= state.top && row < state.top + view.bodyHeight) return state.top
  return clampTop(row - Math.floor(view.bodyHeight / 3), view)
}

function jumpToMatch(
  state: PagerState,
  view: PagerView,
  direction: 1 | -1
): PagerState
{
  const matches = view.matchesFor(state.query)
  if (matches.length === 0) return { ...state, current: null }
  let index: number
  if (state.current === null)
  {
    // first match at or below the viewport top when nothing is selected yet
    const found = matches.findIndex((row) => row >= state.top)
    index = found < 0 ? 0 : found
  }
  else
  {
    const at = matches.indexOf(state.current)
    const base = at < 0 ? matches.findIndex((row) => row > state.current!) : at
    index =
      at < 0
        ? base < 0
          ? 0
          : direction === 1
            ? base
            : (base - 1 + matches.length) % matches.length
        : (base + direction + matches.length) % matches.length
  }
  const current = matches[index]!
  return { ...state, current, top: revealRow(current, state, view) }
}

function commitSearch(state: PagerState, view: PagerView): PagerState
{
  const query = (state.draft ?? '').trim()
  if (!query) return { ...state, query: '', draft: null, current: null }
  const matches = view.matchesFor(query)
  if (matches.length === 0)
    return { ...state, query, draft: null, current: null }
  const found = matches.findIndex((row) => row >= state.top)
  const current = matches[found < 0 ? 0 : found]!
  return {
    ...state,
    query,
    draft: null,
    current,
    top: revealRow(current, state, view),
  }
}

function reduceSearchInput(
  state: PagerState,
  input: string,
  key: PagerKey,
  view: PagerView
): PagerStep
{
  const draft = state.draft ?? ''
  if (key.ctrl && input.toLowerCase() === 'c') return { state, interrupt: true }
  if (key.return) return { state: commitSearch(state, view) }
  // esc abandons the typed draft but keeps the previous committed query
  if (key.escape) return { state: { ...state, draft: null } }
  if (key.backspace || key.delete)
  {
    return {
      state: {
        ...state,
        draft: draft.slice(0, previousGraphemeOffset(draft, draft.length)),
      },
    }
  }
  if (key.ctrl || key.meta || key.tab || !input) return { state }
  // fast typing arrives as one multi-character token; append it whole
  const clean = sanitizeUntrustedText(input).replace(/\s+/g, ' ')
  if (!clean) return { state }
  return { state: { ...state, draft: `${draft}${clean}` } }
}

// less-style browsing keys; everything unhandled leaves the state untouched
export function reducePagerInput(
  state: PagerState,
  input: string,
  key: PagerKey,
  view: PagerView
): PagerStep
{
  if (state.draft !== null) return reduceSearchInput(state, input, key, view)

  const letter = input
  if (key.ctrl && letter.toLowerCase() === 'c')
    return { state, interrupt: true }
  if (key.escape || (!key.ctrl && !key.meta && letter === 'q'))
    return { state, close: true }

  const page = Math.max(view.bodyHeight - 1, 1)
  const half = Math.max(Math.floor(view.bodyHeight / 2), 1)
  const move = (delta: number): PagerStep => ({
    state: { ...state, top: clampTop(state.top + delta, view) },
  })

  if (key.downArrow || (!key.ctrl && letter === 'j')) return move(1)
  if (key.upArrow || (!key.ctrl && letter === 'k')) return move(-1)
  if (key.wheelDown) return move(WHEEL_ROWS)
  if (key.wheelUp) return move(-WHEEL_ROWS)
  if (key.pageDown || (!key.ctrl && (letter === ' ' || letter === 'f')))
    return move(page)
  if (key.pageUp || (!key.ctrl && letter === 'b')) return move(-page)
  if (letter.toLowerCase() === 'd' && (key.ctrl || letter === 'd'))
    return move(half)
  if (letter.toLowerCase() === 'u' && (key.ctrl || letter === 'u'))
    return move(-half)
  if (key.home || (!key.ctrl && letter === 'g'))
    return { state: { ...state, top: 0 } }
  if (key.end || (!key.ctrl && letter === 'G'))
    return {
      state: { ...state, top: maxPagerTop(view.total, view.bodyHeight) },
    }
  if (!key.ctrl && !key.meta && letter === '/')
    return { state: { ...state, draft: '' } }
  if (!key.ctrl && !key.meta && letter === 'n' && state.query)
    return { state: jumpToMatch(state, view, 1) }
  if (!key.ctrl && !key.meta && letter === 'N' && state.query)
    return { state: jumpToMatch(state, view, -1) }
  return { state }
}

// rebuild a matching row from its stripped text so highlighting stays
// ansi-safe; the row keeps its width because escapes take no columns
export function highlightRow(
  row: string,
  query: string,
  isCurrent: boolean
): string
{
  if (!query) return row
  const plain = stripAnsi(row)
  const lower = plain.toLowerCase()
  const needle = query.toLowerCase()
  const mark = isCurrent ? selectionStyle() : chalk.inverse
  if (!lower.includes(needle)) return row
  // case folding changed the length, so offsets no longer line up
  if (lower.length !== plain.length) return mark(plain)
  let out = ''
  let from = 0
  let at = lower.indexOf(needle)
  while (at >= 0)
  {
    out += plain.slice(from, at) + mark(plain.slice(at, at + needle.length))
    from = at + needle.length
    at = lower.indexOf(needle, from)
  }
  return out + plain.slice(from)
}

export function buildPagerTitle(width: number): string
{
  const label = ' transcript '
  const rule = '─'.repeat(Math.max(width - visibleWidth(label), 0))
  return chalk.dim(truncateLine(`${label}${rule}`, width))
}

// position, search status, how many rows wait below, and the key hints
export function buildPagerFooter(
  state: PagerState,
  view: Pick<PagerView, 'total' | 'bodyHeight'>,
  matches: readonly number[],
  width: number
): string
{
  if (state.draft !== null)
  {
    return truncateLine(
      `/${sanitizeUntrustedText(state.draft)}▌ ${chalk.dim('· enter finds · esc cancels')}`,
      width
    )
  }
  const from = view.total === 0 ? 0 : state.top + 1
  const to = Math.min(state.top + view.bodyHeight, view.total)
  const parts = [`${from}-${to}/${view.total}`]
  if (state.query)
  {
    // after a rewrap the selected row is dropped, so show the count alone
    const index = state.current === null ? -1 : matches.indexOf(state.current)
    parts.push(
      matches.length === 0
        ? `no matches "${state.query}"`
        : index < 0
          ? `${matches.length} match${matches.length === 1 ? '' : 'es'} "${state.query}"`
          : `${index + 1}/${matches.length} "${state.query}"`
    )
  }
  const below = view.total - to
  if (below > 0) parts.push(`↓ ${below} new`)
  const hints = chalk.dim('/ search · n/N · q closes')
  return truncateLine(`${parts.join(' · ')} ${chalk.dim('·')} ${hints}`, width)
}
