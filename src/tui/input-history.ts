// src/tui/input-history.ts
// persistent input history w/ JSONL storage & navigation state machine

import {
  readFileSync,
  appendFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { getCoralHome } from '../utils/coral-home.js'

// maximum entries kept in the history file
export const MAX_ENTRIES = 500

export interface HistoryEntry
{
  text: string
  timestamp: number
  sessionId: string | null
}

function historyPath(): string
{
  return join(getCoralHome(), 'history.jsonl')
}

// result of a navigation operation
export interface NavigationResult
{
  index: number
  draft: string
  // text to display, or null if at boundary (no change)
  text: string | null
}

// load all entries from disk, skip corrupt lines, trim if needed
export function loadHistory(): HistoryEntry[]
{
  const path = historyPath()
  if (!existsSync(path)) return []

  let raw: string
  try
  {
    raw = readFileSync(path, 'utf-8')
  }
  catch
  {
    return []
  }

  const entries: HistoryEntry[] = []

  for (const line of raw.split('\n'))
  {
    if (!line.trim()) continue

    try
    {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (
        typeof parsed.text === 'string' &&
        typeof parsed.timestamp === 'number'
      )
      {
        entries.push({
          text: parsed.text,
          timestamp: parsed.timestamp,
          sessionId:
            typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
        })
      }
    }
    catch
    {
      // skip corrupt lines
    }
  }

  // trim to MAX_ENTRIES if needed (keep newest)
  if (entries.length > MAX_ENTRIES)
  {
    const trimmed = entries.slice(-MAX_ENTRIES)
    writeHistoryFile(trimmed)
    return trimmed
  }

  return entries
}

// append a single entry to disk — O(1), no full-file read
// the MAX_ENTRIES cap is enforced on load (loadHistory trims & rewrites), so the
// file may briefly exceed the cap within a long session but never on disk reload
export function appendHistoryEntry(entry: HistoryEntry): void
{
  const path = historyPath()
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8')
}

// rewrite the history file w/ the given entries
function writeHistoryFile(entries: HistoryEntry[]): void
{
  const path = historyPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf-8'
  )
}

// navigate up (older) in history
export function computeNavigateUp(
  entries: HistoryEntry[],
  currentIndex: number,
  currentInput: string,
  currentDraft: string
): NavigationResult
{
  if (entries.length === 0)
  {
    return { index: currentIndex, draft: currentDraft, text: null }
  }

  // entering history mode from draft
  if (currentIndex === -1)
  {
    const nextIndex = entries.length - 1
    return {
      index: nextIndex,
      draft: currentInput,
      text: entries[nextIndex]!.text,
    }
  }

  // already at oldest
  if (currentIndex <= 0)
  {
    return { index: currentIndex, draft: currentDraft, text: null }
  }

  // move to older entry
  const nextIndex = currentIndex - 1
  return {
    index: nextIndex,
    draft: currentDraft,
    text: entries[nextIndex]!.text,
  }
}

// navigate down (newer) in history
export function computeNavigateDown(
  entries: HistoryEntry[],
  currentIndex: number,
  draft: string
): NavigationResult
{
  // already at draft — nowhere to go
  if (currentIndex === -1)
  {
    return { index: -1, draft, text: null }
  }

  const nextIndex = currentIndex + 1

  // past the newest entry — return to draft
  if (nextIndex >= entries.length)
  {
    return { index: -1, draft, text: draft }
  }

  // move to newer entry
  return {
    index: nextIndex,
    draft,
    text: entries[nextIndex]!.text,
  }
}
