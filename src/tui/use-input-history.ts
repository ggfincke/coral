// src/tui/use-input-history.ts
// React hook for navigating & persisting input history

import { useCallback, useRef } from 'react'
import {
  loadHistory,
  appendHistoryEntry,
  computeNavigateUp,
  computeNavigateDown,
  MAX_ENTRIES,
  type HistoryEntry,
} from './input-history.js'

export interface InputHistoryControls
{
  // navigate up (older) — returns entry text, or null if at oldest
  navigateUp: (currentInput: string) => string | null
  // navigate down (newer) — returns entry text or draft, or null if already at draft
  navigateDown: () => string | null
  // record an entry after submission
  addEntry: (text: string, sessionId: string | null) => void
  // exit history mode (call when user edits text manually)
  resetNavigation: () => void
}

export function useInputHistory(): InputHistoryControls
{
  const entriesRef = useRef<HistoryEntry[]>([])
  const indexRef = useRef(-1)
  const draftRef = useRef('')
  const loadedRef = useRef(false)

  const ensureLoaded = useCallback(() =>
  {
    if (loadedRef.current) return
    loadedRef.current = true
    entriesRef.current = loadHistory()
  }, [])

  const navigateUp = useCallback((currentInput: string): string | null =>
  {
    ensureLoaded()

    const result = computeNavigateUp(
      entriesRef.current,
      indexRef.current,
      currentInput,
      draftRef.current
    )

    indexRef.current = result.index
    draftRef.current = result.draft
    return result.text
  }, [ensureLoaded])

  const navigateDown = useCallback((): string | null =>
  {
    ensureLoaded()

    const result = computeNavigateDown(
      entriesRef.current,
      indexRef.current,
      draftRef.current
    )

    indexRef.current = result.index
    return result.text
  }, [ensureLoaded])

  const addEntry = useCallback((text: string, sessionId: string | null) =>
  {
    ensureLoaded()

    const entries = entriesRef.current

    // deduplicate: skip if identical to most recent entry
    if (entries.length > 0 && entries[entries.length - 1]!.text === text)
    {
      resetNavigation()
      return
    }

    const entry: HistoryEntry = {
      text,
      timestamp: Date.now(),
      sessionId,
    }

    entries.push(entry)
    appendHistoryEntry(entry)

    // trim if over max
    if (entries.length > MAX_ENTRIES)
    {
      entriesRef.current = entries.slice(-MAX_ENTRIES)
    }

    resetNavigation()
  }, [ensureLoaded])

  const resetNavigation = useCallback(() =>
  {
    indexRef.current = -1
    draftRef.current = ''
  }, [])

  return { navigateUp, navigateDown, addEntry, resetNavigation }
}
