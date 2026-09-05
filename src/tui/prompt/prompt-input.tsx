// src/tui/prompt/prompt-input.tsx
// inline prompt input with unified keyboard, wheel, and safe text insertion

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, usePaste } from 'ink'
import { style } from '../theme.js'
import { useCoralInput } from '../input/use-coral-input.js'
import {
  buildKey,
  isParsedControlSequence,
  isParsedControlFragment,
  type CoralKey,
} from '../input/terminal-input.js'
import {
  matchPromptKeybinding,
  resolveOverrideAction,
} from '../input/keybindings.js'
import {
  applyPromptEdit,
  continueWithNewline,
  insertTextAt,
} from './prompt-edit.js'
import { buildLineStarts, verticalMove } from './line-index.js'
import {
  EMPTY_EDITOR_MEMORY,
  nextKillIndex,
  popUndo,
  pushKill,
  pushUndo,
  type EditOpKind,
  type EditorMemory,
} from './editor-history.js'
import {
  cycleHistorySearchMatch,
  historySearchPreview,
  IDLE_HISTORY_SEARCH,
  startHistorySearch,
  updateHistorySearchQuery,
  type HistorySearchState,
} from './history-search.js'
import type { HistoryEntry } from './input-history.js'
import {
  applyVimInput,
  createVimEngine,
  vimView,
  type VimEngine,
} from './vim.js'
import {
  boundPastedText,
  buildPastePlaceholder,
  expandPastePlaceholders,
  sanitizePastedText,
  shouldPlaceholderize,
} from './paste.js'
import {
  applyCompletion,
  detectCompletion,
  rankCommands,
  rankFiles,
  type CommandSummary,
  type CompletionItem,
} from './completion.js'
import CompletionMenu, { buildCompletionMenuRows } from './completion-menu.js'
import { resetPromptFileSuggestions } from './prompt-file-suggestions.js'
import {
  buildPromptRenderModel,
  fitPromptLine,
  MAX_PROMPT_VIEW_ROWS,
} from './prompt-render.js'

export interface PromptInputProps
{
  value: string
  placeholder?: string
  focus?: boolean
  showCursor?: boolean
  width?: number
  maxHeight?: number
  onHeightChange?: (rows: number) => void
  filesCacheKey?: string
  completionCommands?: CommandSummary[]
  refreshFiles?: () => Promise<string[]>
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onEscape: () => void
  onInterrupt: () => void
  onPageUp: () => void
  onPageDown: () => void
  onJumpTop: () => void
  onJumpBottom: () => void
  onHalfPageUp: () => void
  onHalfPageDown: () => void
  onToggleToolOutput: () => void
  onScrollUp: () => void
  onScrollDown: () => void
  onToggleThinking: () => void
  onTogglePermissions: () => void
  onOpenPalette: () => void
  onHistoryUp: () => void
  onHistoryDown: () => void
  // pull the newest queued message into an empty composer; false = no queue
  onQueueEdit?: () => boolean
  // newest-500 history entries for ctrl+r reverse search; absent = disabled
  getHistoryEntries?: () => readonly HistoryEntry[]
  // hand the draft to $EDITOR; resolves after Ink suspends & resumes
  onOpenEditor?: () => Promise<void>
  // route composer keys through the vi engine (NORMAL/INSERT)
  viMode?: boolean
  // canonical chord -> action overrides resolved from prefs at startup
  chordOverrides?: ReadonlyMap<string, string>
}

interface CursorState
{
  value: string
  cursorOffset: number
  cursorWidth: number
}

const EMPTY_HISTORY_ENTRIES: readonly HistoryEntry[] = []

export default function PromptInput({
  value,
  placeholder = '',
  focus = true,
  showCursor = true,
  width = 80,
  maxHeight = 17,
  onHeightChange,
  filesCacheKey,
  completionCommands = [],
  refreshFiles,
  onChange,
  onSubmit,
  onEscape,
  onInterrupt,
  onPageUp,
  onPageDown,
  onJumpTop,
  onJumpBottom,
  onHalfPageUp,
  onHalfPageDown,
  onToggleToolOutput,
  onScrollUp,
  onScrollDown,
  onToggleThinking,
  onTogglePermissions,
  onOpenPalette,
  onHistoryUp,
  onHistoryDown,
  onQueueEdit,
  getHistoryEntries,
  onOpenEditor,
  viMode = false,
  chordOverrides,
}: PromptInputProps)
{
  const [cursor, setCursor] = useState<CursorState>({
    value,
    cursorOffset: value.length,
    cursorWidth: 0,
  })
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const filesCacheKeyRef = useRef(filesCacheKey)
  const fileRequestIdRef = useRef(0)
  const mountedRef = useRef(true)
  const pendingTerminalSequenceRef = useRef('')
  // paste tokens map to their stored full text for send-time expansion; ids
  // stay monotonic so a hand-typed lookalike can never resolve to a token
  const pasteRegistryRef = useRef(new Map<number, string>())
  const nextPasteIdRef = useRef(1)
  const [pendingPasteConfirm, setPendingPasteConfirm] = useState(false)
  // editor memory: undo coalescing, kill ring, yank-pop span, column intent
  const memoryRef = useRef<EditorMemory>(EMPTY_EDITOR_MEMORY)
  const killRingRef = useRef<readonly string[]>([])
  const killIndexRef = useRef(0)
  const lastYankRef = useRef<{ start: number; end: number } | null>(null)
  const preferredColRef = useRef<number | null>(null)
  // ctrl+r reverse search: state here, pre-search composer snapshot in a ref
  const [search, setSearch] = useState<HistorySearchState>(IDLE_HISTORY_SEARCH)
  const searchSavedRef = useRef<{ value: string; cursorOffset: number }>({
    value: '',
    cursorOffset: 0,
  })
  const [viStatusHint, setViStatusHint] = useState<string | null>(null)
  // stale hints are harmless: the render only shows them while viMode is on,
  // and the first NORMAL/INSERT keypress refreshes the value
  const editorBusyRef = useRef(false)
  // vi engine drives the composer while viMode is on; external value changes
  // (paste, history, editor handoff) recreate it preserving the current mode
  const vimEngineRef = useRef<VimEngine | null>(null)
  const vimModeRef = useRef<'insert' | 'normal'>('normal')
  useEffect(() =>
  {
    if (viMode)
    {
      vimEngineRef.current = createVimEngine(value)
      if (vimModeRef.current === 'insert')
      {
        applyVimInput(vimEngineRef.current, { input: 'i' })
      }
    }
    else
    {
      vimEngineRef.current = null
    }
    // recreate ONLY on mode flips; value sync happens in the drive branch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viMode])
  // move the cursor to the end when external value changes invalidate its
  // controlled position
  const hasExternalValue = value !== cursor.value
  const resolvedCursor = useMemo(
    () => ({
      value,
      cursorOffset: Math.min(
        Math.max(hasExternalValue ? value.length : cursor.cursorOffset, 0),
        value.length
      ),
      cursorWidth: 0,
    }),
    [cursor.cursorOffset, hasExternalValue, value]
  )

  // active completion span and ranked suggestions under the cursor
  const query = useMemo(
    () => detectCompletion(value, resolvedCursor.cursorOffset),
    [value, resolvedCursor.cursorOffset]
  )
  const items: CompletionItem[] = useMemo(() =>
  {
    if (!query) return []
    if (query.kind === 'command')
      return rankCommands(query.token, completionCommands)
    return rankFiles(query.token, files)
  }, [query, completionCommands, files])
  const menuRequested =
    focus &&
    showCursor &&
    !dismissed &&
    !hasExternalValue &&
    !search.active &&
    !viMode &&
    query !== null &&
    items.length > 0
  const safeIndex = Math.min(selectedIndex, items.length - 1)

  // reset cwd-bound completion state before starting a new-cwd refresh
  const needFiles = query?.kind === 'file'
  useEffect(() =>
  {
    if (filesCacheKeyRef.current === filesCacheKey) return
    filesCacheKeyRef.current = filesCacheKey
    fileRequestIdRef.current += 1

    const reset = resetPromptFileSuggestions()
    setFiles(reset.files)
    setSelectedIndex(reset.selectedIndex)
    setDismissed(reset.dismissed)
  }, [filesCacheKey])

  useEffect(() =>
  {
    mountedRef.current = true
    return () =>
    {
      mountedRef.current = false
    }
  }, [])

  // refresh whenever a fresh @-mention query opens
  useEffect(() =>
  {
    if (!needFiles || !refreshFiles)
    {
      fileRequestIdRef.current += 1
      return
    }

    const requestId = ++fileRequestIdRef.current
    const requestCacheKey = filesCacheKey
    void refreshFiles()
      .then((loaded) =>
      {
        if (
          mountedRef.current &&
          fileRequestIdRef.current === requestId &&
          filesCacheKeyRef.current === requestCacheKey
        )
        {
          setFiles(loaded)
        }
      })
      .catch(() => undefined)

    return () =>
    {
      if (fileRequestIdRef.current === requestId) fileRequestIdRef.current += 1
    }
  }, [filesCacheKey, needFiles, refreshFiles])

  // splice the highlighted suggestion into the prompt and close the menu
  const acceptCompletion = useCallback(() =>
  {
    if (!query || items.length === 0) return
    const item = items[Math.min(selectedIndex, items.length - 1)]!
    const next = applyCompletion(value, query, item)
    setCursor({
      value: next.value,
      cursorOffset: next.cursorOffset,
      cursorWidth: 0,
    })
    setSelectedIndex(0)
    if (next.value !== value) onChange(next.value)
  }, [items, onChange, query, selectedIndex, value])

  // every mutation funnels through here so undo capture, menu state, & the
  // vertical column intent stay consistent
  const commitEdit = useCallback(
    (
      next: {
        value: string
        cursorOffset: number
        cursorWidth: number
        killed?: string
      },
      op: EditOpKind
    ) =>
    {
      memoryRef.current = pushUndo(
        memoryRef.current,
        { value, cursorOffset: resolvedCursor.cursorOffset },
        op
      )
      if (next.killed)
      {
        killRingRef.current = pushKill(killRingRef.current, next.killed)
        killIndexRef.current = 0
      }
      lastYankRef.current = null
      preferredColRef.current = null

      setCursor({
        value: next.value,
        cursorOffset: next.cursorOffset,
        cursorWidth: next.cursorWidth,
      })
      if (next.value !== value)
      {
        onChange(next.value)
        setDismissed(false)
        setSelectedIndex(0)
        setPendingPasteConfirm(false)
      }
    },
    [onChange, resolvedCursor.cursorOffset, value]
  )

  const undoEdit = useCallback(() =>
  {
    const popped = popUndo(memoryRef.current, {
      value,
      cursorOffset: resolvedCursor.cursorOffset,
    })
    memoryRef.current = popped.memory
    const restore = popped.restore
    if (!restore || restore.value === value) return

    setCursor({
      value: restore.value,
      cursorOffset: restore.cursorOffset,
      cursorWidth: 0,
    })
    onChange(restore.value)
    setDismissed(false)
    setSelectedIndex(0)
  }, [onChange, resolvedCursor.cursorOffset, value])

  const yankText = useCallback(
    (text: string) =>
    {
      if (!text) return
      commitEdit(
        insertTextAt(value, resolvedCursor.cursorOffset, text),
        'other'
      )
      const start = resolvedCursor.cursorOffset
      lastYankRef.current = { start, end: start + text.length }
      killIndexRef.current = 0
    },
    [commitEdit, resolvedCursor.cursorOffset, value]
  )

  const yankPopCycle = useCallback(() =>
  {
    const span = lastYankRef.current
    const ring = killRingRef.current
    if (!span || ring.length < 2) return

    killIndexRef.current = nextKillIndex(ring.length, killIndexRef.current)
    const replacement = ring[killIndexRef.current] ?? ''
    const nextValue =
      value.slice(0, span.start) + replacement + value.slice(span.end)
    setCursor({
      value: nextValue,
      cursorOffset: span.start + replacement.length,
      cursorWidth: 0,
    })
    onChange(nextValue)
    lastYankRef.current = {
      start: span.start,
      end: span.start + replacement.length,
    }
  }, [onChange, value])

  // classify an edit for undo coalescing: plain single-character typing runs
  // collapse into one unit, everything else stands alone
  const editOpKind = useCallback((input: string, key: CoralKey): EditOpKind =>
  {
    const plain =
      input.length === 1 &&
      input >= ' ' &&
      input !== '\x7f' &&
      !key.ctrl &&
      !key.meta &&
      !key.backspace &&
      !key.delete &&
      !key.tab &&
      !key.return &&
      !key.escape
    return plain ? 'char-insert' : 'other'
  }, [])

  // leave search mode; restore=true puts the pre-search draft back untouched
  const finishSearch = useCallback((restore: boolean) =>
  {
    const saved = searchSavedRef.current
    setSearch(IDLE_HISTORY_SEARCH)
    if (!restore) return

    setCursor({
      value: saved.value,
      cursorOffset: saved.cursorOffset,
      cursorWidth: 0,
    })
  }, [])

  const handleSearchInput = useCallback(
    (input: string, key: CoralKey) =>
    {
      const entries = getHistoryEntries?.() ?? []

      if (key.ctrl && input === 'r')
      {
        setSearch((prev) => cycleHistorySearchMatch(entries, prev))
        return
      }
      if (key.escape)
      {
        // esc cancels & restores; it must never abort a run from here
        finishSearch(true)
        return
      }
      if (key.return)
      {
        const preview = historySearchPreview(
          getHistoryEntries?.() ?? [],
          search
        )
        if (preview !== null)
        {
          onChange(preview)
          setCursor({
            value: preview,
            cursorOffset: preview.length,
            cursorWidth: 0,
          })
        }
        setSearch(IDLE_HISTORY_SEARCH)
        return
      }
      if (key.backspace || key.delete)
      {
        setSearch((prev) =>
          updateHistorySearchQuery(
            entries,
            prev,
            [...prev.query].slice(0, -1).join('')
          )
        )
        return
      }
      if (!input || key.ctrl || key.meta)
      {
        // unhandled control keys close search w/ the draft preserved
        finishSearch(true)
        return
      }

      setSearch((prev) =>
        updateHistorySearchQuery(entries, prev, prev.query + input)
      )
    },
    [finishSearch, getHistoryEntries, onChange, search]
  )

  // splice pasted text at the cursor through the same edit path as typing so
  // cursor clamping & menu state stay in sync
  const insertPastedText = useCallback(
    (text: string) =>
    {
      const nextState = applyPromptEdit({
        value,
        input: text,
        key: buildKey(),
        cursor: {
          cursorOffset: resolvedCursor.cursorOffset,
          cursorWidth: 0,
        },
      })
      if (!nextState || nextState.value === value) return
      commitEdit(nextState, 'other')
    },
    [commitEdit, resolvedCursor.cursorOffset, value]
  )

  // bracketed pastes arrive on a channel useInput never sees; DECSET 2004
  // enablement & refcounting belong to the hook itself
  const handlePaste = useCallback(
    (raw: string) =>
    {
      const text = sanitizePastedText(raw)
      if (!text) return
      if (search.active)
      {
        const entries = getHistoryEntries?.() ?? []
        setSearch((current) =>
          updateHistorySearchQuery(entries, current, current.query + text)
        )
        return
      }

      if (!shouldPlaceholderize(text))
      {
        insertPastedText(text)
        return
      }

      const id = nextPasteIdRef.current
      nextPasteIdRef.current += 1
      const bounded = boundPastedText(text)

      const registry = pasteRegistryRef.current
      while (registry.size >= 32)
      {
        const oldest = registry.keys().next().value
        if (oldest === undefined) break
        registry.delete(oldest)
      }
      registry.set(id, bounded.text)

      insertPastedText(buildPastePlaceholder(id, text))
      setPendingPasteConfirm(true)
    },
    [getHistoryEntries, insertPastedText, search.active]
  )
  usePaste(handlePaste, { isActive: focus })

  // during search the composer previews the current match without touching
  // the real draft state
  const searchPreviewText = search.active
    ? historySearchPreview(
        getHistoryEntries?.() ?? EMPTY_HISTORY_ENTRIES,
        search
      )
    : null
  const displayValue = searchPreviewText ?? value
  const contentWidth = Math.max(1, Math.floor(width))
  const rowBudget = Math.max(1, Math.floor(maxHeight))
  const searchLabel = searchPreviewText === null ? 'no match' : 'find'
  const searchActions =
    contentWidth >= 70
      ? ' · Enter use · Esc cancel · Ctrl+R older'
      : ' · Enter use · Esc cancel'
  const searchQuery = fitPromptLine(
    search.query,
    Math.max(1, contentWidth - searchLabel.length - searchActions.length - 3)
  )
  const hint = search.active
    ? `${searchLabel} '${searchQuery}'${searchActions}`
    : focus && pendingPasteConfirm && !viMode
      ? 'pasted text armed · Enter confirms · next Enter sends'
      : viMode && viStatusHint
        ? viStatusHint
        : null
  const hintRows = hint && rowBudget > 1 ? 1 : 0
  const displayPlaceholder = displayValue.length === 0 && placeholder.length > 0
  const draft = useMemo(
    () =>
      buildPromptRenderModel(
        displayPlaceholder
          ? fitPromptLine(placeholder, contentWidth)
          : displayValue,
        displayPlaceholder
          ? 0
          : searchPreviewText !== null
            ? displayValue.length
            : resolvedCursor.cursorOffset,
        0,
        contentWidth,
        Math.min(MAX_PROMPT_VIEW_ROWS, rowBudget - hintRows),
        showCursor && focus
      ),
    [
      contentWidth,
      displayPlaceholder,
      displayValue,
      focus,
      hintRows,
      placeholder,
      resolvedCursor.cursorOffset,
      rowBudget,
      searchPreviewText,
      showCursor,
    ]
  )
  const completionRows =
    menuRequested && query
      ? buildCompletionMenuRows(
          items,
          safeIndex,
          query.kind,
          contentWidth,
          rowBudget - draft.rows.length - hintRows
        )
      : []
  // a hidden suggestion must never consume Enter or navigation keys
  const menuOpen = completionRows.some((row) => !row.detail)
  const renderedHeight = draft.rows.length + hintRows + completionRows.length
  useEffect(() =>
  {
    onHeightChange?.(renderedHeight)
  }, [onHeightChange, renderedHeight])

  const handleInput = useCallback(
    (input: string, key: CoralKey) =>
    {
      if (pendingTerminalSequenceRef.current)
      {
        const combinedInput = pendingTerminalSequenceRef.current + input

        if (isParsedControlFragment(combinedInput))
        {
          pendingTerminalSequenceRef.current = combinedInput
          return
        }
        if (isParsedControlSequence(combinedInput))
        {
          pendingTerminalSequenceRef.current = ''
          return
        }

        pendingTerminalSequenceRef.current = ''
      }

      if (key.ctrl && input === 'c')
      {
        if (search.active) finishSearch(true)
        onInterrupt()
        return
      }
      // the App-lifetime terminal owner handles job-control input
      if (key.ctrl && input === 'z') return

      if (key.wheelUp)
      {
        onScrollUp()
        return
      }
      if (key.wheelDown)
      {
        onScrollDown()
        return
      }

      // transcript navigation wins over composer arrows so meta-modified
      // scrolls & ctrl+jumps reach App even inside a multi-line draft;
      // session chord overrides are consulted before the built-in defaults
      const binding =
        resolveOverrideAction(input, key, chordOverrides) ??
        matchPromptKeybinding(input, key)
      if (binding === 'jump-top')
      {
        onJumpTop()
        return
      }
      if (binding === 'jump-bottom')
      {
        onJumpBottom()
        return
      }
      if (binding === 'half-page-up')
      {
        onHalfPageUp()
        return
      }
      if (binding === 'half-page-down')
      {
        onHalfPageDown()
        return
      }
      if (binding === 'toggle-tool-output')
      {
        onToggleToolOutput()
        return
      }
      if (binding === 'page-up')
      {
        onPageUp()
        return
      }
      if (binding === 'page-down')
      {
        onPageDown()
        return
      }
      if (binding === 'toggle-thinking')
      {
        onToggleThinking()
        return
      }
      if (binding === 'toggle-permissions')
      {
        onTogglePermissions()
        return
      }
      if (binding === 'open-palette')
      {
        onOpenPalette()
        return
      }
      if (binding === 'open-editor' && onOpenEditor)
      {
        if (!editorBusyRef.current)
        {
          editorBusyRef.current = true
          void onOpenEditor().finally(() =>
          {
            editorBusyRef.current = false
          })
        }
        return
      }

      // ctrl+r opens reverse search over history; an active search owns every
      // key except ctrl+c, which cancels first then still interrupts
      if (!search.active && getHistoryEntries && key.ctrl && input === 'r')
      {
        searchSavedRef.current = {
          value,
          cursorOffset: resolvedCursor.cursorOffset,
        }
        setSearch(startHistorySearch())
        return
      }
      if (search.active)
      {
        handleSearchInput(input, key)
        return
      }

      // application shortcuts keep priority in vi mode; only editor input
      // reaches the engine, so ctrl/meta keys cannot become literal letters
      if (viMode && vimEngineRef.current)
      {
        if (
          (key.ctrl || key.meta) &&
          !(key.ctrl && input === 'j') &&
          !key.return
        )
          return

        const engine = vimEngineRef.current
        const before = vimView(engine)
        if (before.value !== value)
        {
          vimEngineRef.current = createVimEngine(value)
          if (before.mode === 'insert')
          {
            applyVimInput(vimEngineRef.current, { input: 'i' })
          }
        }

        const next = applyVimInput(vimEngineRef.current, {
          input: key.return ? '' : key.ctrl && input === 'j' ? '\n' : input,
          escape: key.escape,
          return: key.return,
          backspace: key.backspace,
          delete: key.delete,
        })
        vimModeRef.current = next.mode
        setViStatusHint(next.statusHint)

        if (next.submitRequested)
        {
          onSubmit(
            expandPastePlaceholders(next.value, (id) =>
              pasteRegistryRef.current.get(id)
            )
          )
          vimEngineRef.current = createVimEngine('')
          setCursor({ value: '', cursorOffset: 0, cursorWidth: 0 })
          return
        }

        if (next.value !== value)
        {
          onChange(next.value)
        }
        setCursor({
          value: next.value,
          cursorOffset: Math.min(next.cursorOffset, next.value.length),
          cursorWidth: 0,
        })
        return
      }

      if (key.return && (key.meta || key.shift))
      {
        commitEdit(
          insertTextAt(value, resolvedCursor.cursorOffset, '\n'),
          'other'
        )
        return
      }

      // the completion menu owns arrows/tab/enter/escape while it's open
      if (menuOpen)
      {
        if (key.upArrow)
        {
          setSelectedIndex((i) => Math.max(0, i - 1))
          return
        }
        if (key.downArrow)
        {
          setSelectedIndex((i) => Math.min(items.length - 1, i + 1))
          return
        }
        if (key.tab || key.return)
        {
          acceptCompletion()
          return
        }
        if (key.escape)
        {
          setDismissed(true)
          setSelectedIndex(0)
          return
        }
      }

      if (key.upArrow || key.downArrow)
      {
        // vertical movement owns the arrows inside a multi-line draft; history
        // recall takes over at the first/last-line boundaries
        const deltaRows = key.upArrow ? -1 : 1
        const starts = buildLineStarts(value)
        const moved = verticalMove(
          value,
          starts,
          resolvedCursor.cursorOffset,
          deltaRows,
          preferredColRef.current
        )
        if (moved.offset !== resolvedCursor.cursorOffset)
        {
          preferredColRef.current = moved.preferredCol
          setCursor({
            value,
            cursorOffset: moved.offset,
            cursorWidth: 0,
          })
          return
        }

        if (key.upArrow)
        {
          onHistoryUp()
        }
        else
        {
          onHistoryDown()
        }
        return
      }

      if (key.escape)
      {
        onEscape()
        return
      }
      if (key.ctrl && input === '_')
      {
        undoEdit()
        return
      }
      if (key.ctrl && input === 'v')
      {
        yankText(killRingRef.current[0] ?? '')
        return
      }
      if (key.meta && input === 'y')
      {
        yankPopCycle()
        return
      }
      // meta+backspace edits the queue when one exists; otherwise it stays a
      // normal backward word-kill
      if (key.meta && key.backspace && onQueueEdit && value.length === 0)
      {
        if (onQueueEdit()) return
      }
      if (key.tab)
      {
        return
      }
      if (key.return)
      {
        // first Enter after a multi-line paste confirms it instead of sending
        // the whole block straight to the model
        if (pendingPasteConfirm)
        {
          setPendingPasteConfirm(false)
          return
        }

        // trailing '\' continues onto a new line instead of submitting
        const continued = continueWithNewline(
          value,
          resolvedCursor.cursorOffset
        )
        if (continued)
        {
          commitEdit(continued, 'other')
          return
        }

        onSubmit(
          expandPastePlaceholders(value, (id) =>
            pasteRegistryRef.current.get(id)
          )
        )
        // reset the cursor after a real submit so later history recall does not
        // reuse a stale mid-text position
        if (value.trim())
        {
          setCursor({ value: '', cursorOffset: 0, cursorWidth: 0 })
          memoryRef.current = EMPTY_EDITOR_MEMORY
          killRingRef.current = []
          killIndexRef.current = 0
          lastYankRef.current = null
          preferredColRef.current = null
        }
        return
      }
      if (isParsedControlFragment(input))
      {
        pendingTerminalSequenceRef.current = input
        return
      }
      if (isParsedControlSequence(input))
      {
        return
      }
      const nextState = applyPromptEdit({
        value,
        input,
        key,
        cursor: resolvedCursor,
      })
      if (!nextState) return

      commitEdit(nextState, editOpKind(input, key))
    },
    [
      acceptCompletion,
      commitEdit,
      editOpKind,
      finishSearch,
      getHistoryEntries,
      handleSearchInput,
      items.length,
      menuOpen,
      onEscape,
      onHistoryDown,
      onHistoryUp,
      onInterrupt,
      chordOverrides,
      onChange,
      onJumpBottom,
      onJumpTop,
      onHalfPageDown,
      onHalfPageUp,
      onOpenPalette,
      onPageDown,
      onPageUp,
      onScrollDown,
      onScrollUp,
      onSubmit,
      onTogglePermissions,
      onToggleThinking,
      onToggleToolOutput,
      onOpenEditor,
      onQueueEdit,
      pendingPasteConfirm,
      resolvedCursor,
      search.active,
      undoEdit,
      value,
      viMode,
      yankPopCycle,
      yankText,
    ]
  )

  useCoralInput(handleInput, { isActive: focus })

  return (
    <Box flexDirection="column" width={contentWidth} flexShrink={0}>
      {draft.rows.map((row, index) => (
        <Box key={index} height={1} flexShrink={0}>
          <Text wrap="truncate-end">
            {displayPlaceholder ? style('muted')(row) : row || ' '}
          </Text>
        </Box>
      ))}
      {hintRows > 0 && (
        <Box height={1} flexShrink={0}>
          <Text wrap="truncate-end">
            {style('muted')(fitPromptLine(hint ?? '', contentWidth))}
          </Text>
        </Box>
      )}
      <CompletionMenu rows={completionRows} width={contentWidth} />
    </Box>
  )
}
