// src/tui/input-history.ts
// persistent input history w/ JSONL storage & navigation state machine

import {
  readFileSync,
  appendFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const HISTORY_PATH = join(homedir(), '.coral', 'history.jsonl')

// maximum entries kept in the history file
export const MAX_ENTRIES = 500

export interface HistoryEntry
{
  text: string
  timestamp: number
  sessionId: string | null
}

// navigation state for Up/Down arrow recall
export interface NavigationState
{
  // current index into the entries array (-1 = at draft, not navigating)
  index: number
  // stashed draft text from before navigation began
  draft: string
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
  if (!existsSync(HISTORY_PATH)) return []

  let raw: string
  try
  {
    raw = readFileSync(HISTORY_PATH, 'utf-8')
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
      if (typeof parsed.text === 'string' && typeof parsed.timestamp === 'number')
      {
        entries.push({
          text: parsed.text,
          timestamp: parsed.timestamp,
          sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
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

// append a single entry to disk
export function appendHistoryEntry(entry: HistoryEntry): void
{
  mkdirSync(dirname(HISTORY_PATH), { recursive: true })
  appendFileSync(HISTORY_PATH, JSON.stringify(entry) + '\n', 'utf-8')
}

// rewrite the history file w/ the given entries
function writeHistoryFile(entries: HistoryEntry[]): void
{
  mkdirSync(dirname(HISTORY_PATH), { recursive: true })
  writeFileSync(
    HISTORY_PATH,
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
