// src/tui/prompt/input-history.ts
// persistent input history w/ JSONL storage & navigation state machine

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs'
import { coralHomePath } from '../../utils/coral-home.js'
import { ensureParentDir } from '../../utils/fs.js'
import { isPlainObject } from '../../utils/guards.js'
import { tryParseJson } from '../../utils/json.js'

// maximum entries retained for prompt navigation in one process
export const MAX_HISTORY_ENTRIES = 500

const HISTORY_READ_CHUNK_BYTES = 64 * 1024
// cap one row so a missing delimiter cannot make the reverse scan unbounded
const MAX_HISTORY_RECORD_BYTES = 1024 * 1024

export interface HistoryEntry
{
  text: string
  timestamp: number
  sessionId: string | null
}

function historyPath(): string
{
  return coralHomePath('history.jsonl')
}

// result of a navigation operation
export interface NavigationResult
{
  index: number
  draft: string
  // text to display, or null if at boundary (no change)
  text: string | null
}

function parseHistoryLine(line: Buffer): HistoryEntry | undefined
{
  if (line.length === 0) return undefined

  const parsed = tryParseJson(line.toString('utf-8').trim())
  if (!isPlainObject(parsed)) return undefined

  if (typeof parsed.text !== 'string' || typeof parsed.timestamp !== 'number')
  {
    return undefined
  }

  return {
    text: parsed.text,
    timestamp: parsed.timestamp,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
  }
}

// load the newest valid entries without mutating the append-only history file
export function loadHistory(): HistoryEntry[]
{
  const path = historyPath()
  if (!existsSync(path)) return []

  let fd: number
  try
  {
    fd = openSync(path, constants.O_RDONLY)
  }
  catch
  {
    return []
  }

  const newestFirst: HistoryEntry[] = []
  let segments: Buffer[] = []
  let recordBytes = 0
  let recordTooLarge = false

  const addSegment = (segment: Buffer): void =>
  {
    if (segment.length === 0 || recordTooLarge) return
    if (recordBytes + segment.length > MAX_HISTORY_RECORD_BYTES)
    {
      segments = []
      recordBytes = 0
      recordTooLarge = true
      return
    }
    segments.unshift(segment)
    recordBytes += segment.length
  }

  const finishRecord = (): void =>
  {
    if (!recordTooLarge)
    {
      const entry = parseHistoryLine(Buffer.concat(segments, recordBytes))
      if (entry) newestFirst.push(entry)
    }
    segments = []
    recordBytes = 0
    recordTooLarge = false
  }

  try
  {
    let position = fstatSync(fd).size
    while (position > 0 && newestFirst.length < MAX_HISTORY_ENTRIES)
    {
      const bytesToRead = Math.min(HISTORY_READ_CHUNK_BYTES, position)
      position -= bytesToRead
      const chunk = Buffer.allocUnsafe(bytesToRead)
      const bytesRead = readSync(fd, chunk, 0, bytesToRead, position)
      let segmentEnd = bytesRead

      for (let index = bytesRead - 1; index >= 0; index--)
      {
        if (chunk[index] !== 0x0a) continue

        addSegment(chunk.subarray(index + 1, segmentEnd))
        finishRecord()
        if (newestFirst.length >= MAX_HISTORY_ENTRIES) break
        segmentEnd = index
      }

      if (newestFirst.length < MAX_HISTORY_ENTRIES)
      {
        addSegment(chunk.subarray(0, segmentEnd))
      }
    }

    if (
      position === 0 &&
      newestFirst.length < MAX_HISTORY_ENTRIES &&
      (recordBytes > 0 || recordTooLarge)
    )
    {
      finishRecord()
    }
  }
  catch
  {
    return []
  }
  finally
  {
    closeSync(fd)
  }

  return newestFirst.reverse()
}

// append one complete JSONL record through a private O_APPEND descriptor
export function appendHistoryEntry(entry: HistoryEntry): void
{
  const path = historyPath()
  ensureParentDir(path)
  // begin every record w/ a delimiter so a crash-truncated tail cannot absorb
  // the next successful append into one corrupt JSONL row
  const record = Buffer.from(`\n${JSON.stringify(entry)}\n`, 'utf-8')
  const fd = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    0o600
  )

  try
  {
    // repair history created by older versions under a permissive umask
    if (process.platform !== 'win32') fchmodSync(fd, 0o600)

    const written = writeSync(fd, record, 0, record.length)
    if (written !== record.length)
    {
      throw new Error(
        `Failed to append complete input history record: wrote ${written} of ${record.length} bytes`
      )
    }
  }
  finally
  {
    closeSync(fd)
  }
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
