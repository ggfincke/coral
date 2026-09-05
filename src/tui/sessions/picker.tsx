// src/tui/sessions/picker.tsx
// interactive saved-session picker with fuzzy filter and transcript preview

import { useCallback, useEffect, useMemo, useState } from 'react'
import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import { listSessions, loadSessionPreview } from '../../session/store.js'
import type { OllamaMessage } from '../../types/inference.js'
import type { SessionMeta } from '../../session/types.js'
import { toErrorMessage } from '../../utils/errors.js'
import {
  filterPaletteEntries,
  formatPickerQuery,
  movePaletteSelection,
  reducePaletteInput,
  type PaletteEntry,
} from '../palette/palette.js'
import { formatBlocksPlain } from '../transcript/plain.js'
import { sanitizeUntrustedText } from '../transcript/sanitize.js'
import { buildRestoredBlocks } from '../transcript/restored-blocks.js'
import { useCoralInput } from '../input/use-coral-input.js'
import { getThemeGeneration, selectionStyle, style } from '../theme.js'
import { padEnd, truncateLine, visibleWidth } from '../wrap.js'
import { LineList } from '../components/line-list.js'

// states mirror the model-picker machine; 'hidden' is expressed by the parent
// not mounting this overlay
export type SessionPickerState = 'hidden' | 'loading' | 'ready' | 'error'

// rows jumped by pageUp/pageDown
const PAGE_ROWS = 10
// minimum list rows kept for navigation before preview space is carved out
const MIN_LIST_ROWS = 3
const MAX_LIST_ROWS = 12

export interface SessionPickerLinesOptions
{
  sessions: SessionMeta[]
  query: string
  selectedIndex: number
  width: number
  height: number
  previewLines?: readonly string[]
  // callers restyle retained plain rows when the active theme changes
  themeGeneration?: number
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

interface SessionPreviewTail
{
  lines: string[]
  complete: boolean
}

// walk backward only until the visible tail is filled; restored/plain owners
// retain displayContent, thinking, attachment notices, and tool-output policy
export function buildSessionPreviewTail(
  messages: readonly OllamaMessage[],
  maxRows: number
): SessionPreviewTail
{
  const budget = Math.max(0, Math.floor(maxRows))
  const groups: string[][] = []
  let retained = 0
  let index = messages.length - 1
  for (; index >= 0 && retained < budget; index--)
  {
    const lines = formatBlocksPlain(buildRestoredBlocks([messages[index]!]))
    const tail = lines.slice(Math.max(lines.length - (budget - retained), 0))
    groups.push(tail)
    retained += tail.length
    if (tail.length < lines.length)
    {
      return { lines: groups.reverse().flat(), complete: false }
    }
  }
  return { lines: groups.reverse().flat(), complete: index < 0 }
}

interface CachedSessionPreview
{
  id: string
  revision: string
  tail: SessionPreviewTail
}

const MAX_PREVIEW_CACHE_ROWS = 256
const MAX_PREVIEW_CACHE_BYTES = 256 * 1024

/** Owns one picker preview's cancellation, revision checks, and bounded tail. */
export class SessionPreviewLoader
{
  private controller: AbortController | undefined
  private generation = 0
  private cache: CachedSessionPreview | undefined

  constructor(private readonly readPreview = loadSessionPreview)
  {}

  async load(
    id: string,
    maxRows: number
  ): Promise<SessionPreviewTail | undefined>
  {
    this.cancel()
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    if (this.cache?.id !== id) this.cache = undefined
    const cached = this.cache
    const sufficient =
      cached && (cached.tail.complete || cached.tail.lines.length >= maxRows)
    try
    {
      const result = await this.readPreview(id, {
        knownRevision: sufficient ? cached.revision : undefined,
        signal: controller.signal,
      })
      if (controller.signal.aborted || generation !== this.generation) return
      if (result.kind === 'unchanged') return cached?.tail
      if (result.kind === 'missing')
      {
        this.cache = undefined
        return { lines: [], complete: true }
      }

      const tail = buildSessionPreviewTail(result.messages, maxRows)
      const entry =
        result.revision === null
          ? undefined
          : { id, revision: result.revision, tail }
      this.cache =
        entry &&
        tail.lines.length <= MAX_PREVIEW_CACHE_ROWS &&
        Buffer.byteLength(JSON.stringify(entry)) <= MAX_PREVIEW_CACHE_BYTES
          ? entry
          : undefined
      return tail
    }
    catch (error)
    {
      if (controller.signal.aborted || generation !== this.generation) return
      throw error
    }
  }

  cancel(): void
  {
    this.controller?.abort()
    this.controller = undefined
    this.generation++
  }

  dispose(): void
  {
    this.cancel()
    this.cache = undefined
  }
}

function pickerLayout(sessionCount: number, height: number)
{
  const headerRows =
    Number(height >= 2) + Number(height >= 3) + Number(height >= 6)
  const availableHeight = Math.max(height - headerRows, 0)
  const listRows = Math.min(
    Math.max(Math.floor(availableHeight / 2), MIN_LIST_ROWS),
    MAX_LIST_ROWS,
    sessionCount,
    availableHeight
  )
  const countRows = Number(
    sessionCount > listRows && listRows < availableHeight
  )
  return {
    listRows,
    previewRows: Math.max(availableHeight - listRows - countRows - 1, 0),
  }
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
  lines: readonly string[],
  maxRows: number,
  width: number
): string[]
{
  if (maxRows <= 0) return []
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
  now: number,
  width: number
): string
{
  const titleText =
    sanitizeUntrustedText(meta.title || '(untitled)').replace(/\s+/g, ' ') ||
    '(untitled)'
  const suffixText = ` · ${formatRelativeAge(meta.updatedAt, now)} · ${meta.messageCount} msgs`
  const suffix =
    width >= 20 ? truncateLine(suffixText, Math.max(width - 10, 0)) : ''
  const titleWidth = Math.max(width - 3 - visibleWidth(suffix), 0)
  const shownTitle = padEnd(truncateLine(titleText, titleWidth), titleWidth)
  const styledTitle = selected ? chalk.bold(shownTitle) : shownTitle
  const row = truncateLine(
    ` ${selected ? '›' : ' '} ${styledTitle}${selected ? suffix : chalk.dim(suffix)}`,
    width
  )
  return selected ? selectionStyle()(padEnd(row, width)) : row
}

export function buildSessionPickerLines(
  opts: SessionPickerLinesOptions
): string[]
{
  const width = Math.max(Math.floor(opts.width), 0)
  const height = Math.max(Math.floor(opts.height), 0)
  if (width === 0 || height === 0) return []
  const now = Date.now()
  const sessions = opts.sessions
  const lines: string[] = []
  if (height >= 2)
    lines.push(
      `${style('primary').bold('resume')} ${chalk.dim('saved sessions')}`
    )
  if (height >= 3)
    lines.push(
      formatPickerQuery(
        opts.query,
        width,
        'type to filter · enter resumes · esc cancels'
      )
    )
  if (height >= 6) lines.push('')

  if (sessions.length === 0)
  {
    lines.push(chalk.dim('  no saved sessions'))
    return lines.slice(0, height).map((line) => truncateLine(line, width))
  }

  const selectedIndex = Math.min(
    Math.max(opts.selectedIndex, 0),
    sessions.length - 1
  )

  // split the remaining viewport between rows and the preview pane
  const { listRows, previewRows } = pickerLayout(sessions.length, height)
  const start = Math.min(
    Math.max(selectedIndex - Math.floor(listRows / 2), 0),
    Math.max(sessions.length - listRows, 0)
  )
  const end = Math.min(start + listRows, sessions.length)

  for (let index = start; index < end; index += 1)
  {
    lines.push(
      formatSessionRow(sessions[index]!, index === selectedIndex, now, width)
    )
  }

  if (sessions.length > listRows && lines.length < height)
  {
    lines.push(chalk.dim(`Showing ${start + 1}-${end} of ${sessions.length}`))
  }

  const remaining = height - lines.length
  if (remaining > 1)
  {
    const selected = sessions[selectedIndex]!
    const context = sanitizeUntrustedText(`${selected.model} · ${selected.cwd}`)
      .replace(/\s+/g, ' ')
      .trim()
    lines.push(`${chalk.bold('Preview')} ${chalk.dim(`· ${context}`)}`)
    lines.push(
      ...buildSessionPreviewLines(opts.previewLines ?? [], previewRows, width)
    )
  }

  return lines.slice(0, height).map((line) => truncateLine(line, width))
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
  active?: boolean
  onResume: (sessionId: string) => void
  onClose: () => void
}

export default function SessionPicker({
  width,
  height,
  active = true,
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

  const [reload, setReload] = useState(0)
  const [previewLoader] = useState(() => new SessionPreviewLoader())
  const [preview, setPreview] = useState<{
    id: string
    lines: string[]
  } | null>(null)
  const load = useCallback(() =>
  {
    setState('loading')
    setError('')
    setReload((previous) => previous + 1)
  }, [])

  useEffect(() =>
  {
    const controller = new AbortController()
    // listSessions owns ordering & policy; the picker never refilters by cwd
    void listSessions({ signal: controller.signal }).then(
      (loaded) =>
      {
        if (controller.signal.aborted) return
        setSessions(loaded)
        setState('ready')
      },
      (loadError: unknown) =>
      {
        if (controller.signal.aborted) return
        setError(toErrorMessage(loadError))
        setState('error')
      }
    )
    return () => controller.abort()
  }, [reload])

  useEffect(() => () => previewLoader.dispose(), [previewLoader])

  const matches = useMemo(
    () => filterSessions(sessions, query),
    [query, sessions]
  )
  const safeIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0))
  const selectedId = matches[safeIndex]?.id
  const previewRows = pickerLayout(
    matches.length,
    Math.max(Math.floor(height), 0)
  ).previewRows
  useEffect(() =>
  {
    if (state !== 'ready' || !selectedId || previewRows === 0)
    {
      previewLoader.dispose()
      return
    }
    let disposed = false
    void previewLoader.load(selectedId, previewRows).then(
      (tail) =>
      {
        if (!disposed && tail) setPreview({ id: selectedId, lines: tail.lines })
      },
      () =>
      {
        if (!disposed) setPreview(null)
      }
    )
    return () =>
    {
      disposed = true
      previewLoader.cancel()
    }
  }, [height, previewLoader, previewRows, query, selectedId, state, width])

  const themeGeneration = getThemeGeneration()
  const lines = useMemo(
    () =>
      state === 'ready'
        ? buildSessionPickerLines({
            sessions: matches,
            query,
            selectedIndex: safeIndex,
            width,
            height,
            previewLines: preview?.id === selectedId ? preview.lines : [],
            themeGeneration,
          })
        : state === 'loading'
          ? ['Loading saved sessions…']
          : [
              'Failed to load saved sessions',
              sanitizeUntrustedText(error).replace(/\s+/g, ' ').trim(),
            ],
    [
      error,
      height,
      matches,
      preview,
      query,
      safeIndex,
      selectedId,
      state,
      themeGeneration,
      width,
    ]
  )

  useCoralInput(
    (input, key) =>
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
        if (
          next.state.query !== query ||
          next.state.selectedIndex !== safeIndex
        )
        {
          setPreview(null)
        }
        setQuery(next.state.query)
        setSelectedIndex(next.state.selectedIndex)
      }
    },
    { isActive: active }
  )

  return (
    <LineList
      lines={lines
        .slice(0, Math.max(height, 0))
        .map((line) => truncateLine(line, Math.max(width, 0)))}
    />
  )
}
