// src/tui/prompt/use-input-history.ts
// navigate and persist input history in a React hook

import { useCallback, useRef } from 'react'
import {
  MAX_HISTORY_ENTRIES,
  loadHistory,
  appendHistoryEntry,
  computeNavigateUp,
  computeNavigateDown,
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

  const resetNavigation = useCallback(() =>
  {
    indexRef.current = -1
    draftRef.current = ''
  }, [])

  const navigateUp = useCallback(
    (currentInput: string): string | null =>
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
    },
    [ensureLoaded]
  )

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

  const addEntry = useCallback(
    (text: string, sessionId: string | null) =>
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

      appendHistoryEntry(entry)
      entries.push(entry)
      if (entries.length > MAX_HISTORY_ENTRIES)
      {
        entries.splice(0, entries.length - MAX_HISTORY_ENTRIES)
      }

      resetNavigation()
    },
    [ensureLoaded, resetNavigation]
  )

  return { navigateUp, navigateDown, addEntry, resetNavigation }
}
