// src/tui/sessions/picker.tsx
// interactive saved-session picker with fuzzy filter and transcript preview

import { useCallback, useEffect, useMemo, useState } from 'react'
import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import { listSessions, loadSession } from '../../session/store.js'
import type { SessionMeta } from '../../session/types.js'
import { ellipsize } from '../../utils/ellipsize.js'
import { toErrorMessage } from '../../utils/errors.js'
import {
  filterPaletteEntries,
  movePaletteSelection,
  reducePaletteInput,
  type PaletteEntry,
} from '../palette/palette.js'
import { formatBlocksPlain } from '../transcript/plain.js'
import { sanitizeUntrustedText } from '../transcript/sanitize.js'
import { buildRestoredBlocks } from '../transcript/restored-blocks.js'
import { useCoralInput } from '../input/use-coral-input.js'
import { style } from '../theme.js'
import { LineList } from '../components/line-list.js'

// states mirror the model-picker machine; 'hidden' is expressed by the parent
// not mounting this overlay
export type SessionPickerState = 'hidden' | 'loading' | 'ready' | 'error'

// rows jumped by pageUp/pageDown
const PAGE_ROWS = 10
// minimum list rows kept for navigation before preview space is carved out
const MIN_LIST_ROWS = 3
const MAX_LIST_ROWS = 12
// plain-text caps for one row; titles truncate before styling
const ROW_TITLE_CHARS = 64
const ROW_SUFFIX_CHARS = 32

export interface SessionPickerLinesOptions
{
  sessions: SessionMeta[]
  query: string
  selectedIndex: number
  width: number
  height: number
}

export interface SessionPickerInputState
{
  query: string
  selectedIndex: number
}

export interface SessionPickerInputKey
{
  upArrow?: boolean
  downArrow?: boolean
  pageUp?: boolean
  pageDown?: boolean
  backspace?: boolean
  delete?: boolean
  ctrl?: boolean
  meta?: boolean
}

export interface SessionPickerInputResult
{
  handled: boolean
  state: SessionPickerInputState
}

// compact relative age for row display
export function formatRelativeAge(updatedAt: string, now = Date.now()): string
{
  const elapsed = Math.max(now - Date.parse(updatedAt), 0)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function sessionToEntry(session: SessionMeta): PaletteEntry
{
  // the id rides keywords so typed prefixes filter like titles do; scoring,
  // ranking, and the visible cap all stay owned by the shared palette matcher
  return {
    id: session.id,
    kind: 'command',
    title: session.title || '(untitled)',
    detail: `${formatRelativeAge(session.updatedAt)} · ${session.messageCount} msgs`,
    keywords: [session.id],
  }
}

// newest-first rows narrowed by palette-matcher scoring; an empty query
// preserves listSessions order
export function filterSessions(
  sessions: SessionMeta[],
  query: string
): SessionMeta[]
{
  if (!query.trim()) return sessions
  const pairs = sessions.map((session) => ({
    session,
    entry: sessionToEntry(session),
  }))
  const matched = filterPaletteEntries(
    pairs.map((pair) => pair.entry),
    query
  )
  const byId = new Map(pairs.map((pair) => [pair.session.id, pair.session]))
  return matched
    .map((entry) => byId.get(entry.id))
    .filter((session): session is SessionMeta => session !== undefined)
}

function loadPreviewLines(id: string): string[]
{
  const stored = loadSession(id)
  return stored ? formatBlocksPlain(buildRestoredBlocks(stored.messages)) : []
}

// every returned row occupies one terminal row, including wide characters
function clipRow(line: string, width: number): string
{
  return (
    wrapAnsi(line, Math.max(width, 1), {
      hard: true,
      trim: false,
      wordWrap: false,
    }).split('\n')[0] ?? ''
  )
}

// newest-lines transcript window for the selected session, capped to maxRows
export function buildSessionPreviewLines(
  id: string | undefined,
  maxRows: number,
  width: number
): string[]
{
  if (!id || maxRows <= 0) return []
  const lines = loadPreviewLines(id)
  const start = Math.max(lines.length - maxRows, 0)
  return lines
    .slice(start)
    .map((line) => chalk.dim(clipRow(line, Math.max(width - 2, 8))))
}

// one bounded row; the plain title is truncated before styling so ANSI
// sequences are never sliced mid-escape
function formatSessionRow(
  meta: SessionMeta,
  selected: boolean,
  now: number
): string
{
  const titleText =
    sanitizeUntrustedText(meta.title || '(untitled)').replace(/\s+/g, ' ') ||
    '(untitled)'
  const suffixText = ` · ${formatRelativeAge(meta.updatedAt, now)} · ${meta.messageCount} msgs`
  const shownTitle = ellipsize(titleText, ROW_TITLE_CHARS)
  const marker = selected ? style('accent')('›') : chalk.dim(' ')
  const styledTitle = selected
    ? style('accent').bold(shownTitle)
    : style('user')(shownTitle)
  return ` ${marker} ${styledTitle}${chalk.dim(ellipsize(suffixText, ROW_SUFFIX_CHARS))}`
}

export function buildSessionPickerLines(
  opts: SessionPickerLinesOptions
): string[]
{
  const width = Math.max(opts.width, 24)
  const height = Math.max(opts.height, 6)
  const now = Date.now()
  const query = opts.query.trim()
  const sessions = opts.sessions
  const lines: string[] = [
    `${style('primary').bold('resume')} ${chalk.dim('saved sessions')}`,
    chalk.dim(
      query ? `query: ${query}` : 'type to filter · enter resumes · esc cancels'
    ),
    '',
  ]

  if (sessions.length === 0)
  {
    lines.push(chalk.dim('  no saved sessions'))
    return lines.slice(0, height).map((line) => clipRow(line, width))
  }

  const selectedIndex = Math.min(
    Math.max(opts.selectedIndex, 0),
    sessions.length - 1
  )

  // split the remaining viewport between rows and the preview pane
  const availableHeight = height - lines.length
  const listRows = Math.min(
    Math.max(Math.floor(availableHeight / 2), MIN_LIST_ROWS),
    MAX_LIST_ROWS,
    sessions.length
  )
  const start = Math.min(
    Math.max(selectedIndex - Math.floor(listRows / 2), 0),
    Math.max(sessions.length - listRows, 0)
  )
  const end = Math.min(start + listRows, sessions.length)

  for (let index = start; index < end; index += 1)
  {
    lines.push(formatSessionRow(sessions[index]!, index === selectedIndex, now))
  }

  if (sessions.length > listRows)
  {
    lines.push(chalk.dim(`Showing ${start + 1}-${end} of ${sessions.length}`))
  }

  const remaining = height - lines.length
  if (remaining > 1)
  {
    lines.push(chalk.dim('-'.repeat(Math.min(width, 40))))
    lines.push(
      ...buildSessionPreviewLines(
        sessions[selectedIndex]?.id,
        remaining - 1,
        width
      )
    )
  }

  return lines.slice(0, height).map((line) => clipRow(line, width))
}

// typing filters via the palette matcher; pages jump whole screens
export function reduceSessionPickerInput(
  state: SessionPickerInputState,
  input: string,
  key: SessionPickerInputKey,
  matchCount: number
): SessionPickerInputResult
{
  if (key.pageUp || key.pageDown)
  {
    return {
      handled: true,
      state: {
        ...state,
        selectedIndex: movePaletteSelection(
          state.selectedIndex,
          key.pageUp ? -PAGE_ROWS : PAGE_ROWS,
          matchCount
        ),
      },
    }
  }
  return reducePaletteInput(state, input, key, matchCount)
}

export interface SessionPickerProps
{
  width: number
  height: number
  onResume: (sessionId: string) => void
  onClose: () => void
}

export default function SessionPicker({
  width,
  height,
  onResume,
  onClose,
}: SessionPickerProps)
{
  const [state, setState] =
    useState<Exclude<SessionPickerState, 'hidden'>>('loading')
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const load = useCallback(() =>
  {
    setState('loading')
    setError('')
    try
    {
      // listSessions owns ordering & policy; the picker never refilters by cwd
      setSessions(listSessions())
      setState('ready')
    }
    catch (loadError)
    {
      setError(toErrorMessage(loadError))
      setState('error')
    }
  }, [])

  useEffect(() =>
  {
    queueMicrotask(load)
  }, [load])

  const matches = useMemo(
    () => filterSessions(sessions, query),
    [query, sessions]
  )
  const safeIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0))
  const lines = useMemo(
    () =>
      state === 'ready'
        ? buildSessionPickerLines({
            sessions: matches,
            query,
            selectedIndex: safeIndex,
            width,
            height,
          })
        : state === 'loading'
          ? ['Loading saved sessions…']
          : ['Failed to load saved sessions', error],
    [error, height, matches, query, safeIndex, state, width]
  )

  useCoralInput((input, key) =>
  {
    if (key.escape || (key.ctrl && input.toLowerCase() === 'c'))
    {
      onClose()
      return
    }
    if (state === 'loading') return
    if (state === 'error')
    {
      if (input.toLowerCase() === 'r') load()
      return
    }
    if (key.return)
    {
      const selected = matches[safeIndex]
      if (selected) onResume(selected.id)
      return
    }

    const next = reduceSessionPickerInput(
      { query, selectedIndex: safeIndex },
      input,
      key,
      matches.length
    )
    if (next.handled)
    {
      setQuery(next.state.query)
      setSelectedIndex(next.state.selectedIndex)
    }
  })

  return <LineList lines={lines} />
}
