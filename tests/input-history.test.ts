// tests/input-history.test.ts
// tests for input history persistence & navigation state machine

import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { after, afterEach, test } from 'node:test'

import {
  loadHistory,
  appendHistoryEntry,
  computeNavigateUp,
  computeNavigateDown,
  type HistoryEntry,
} from '../src/tui/input-history.js'

const HISTORY_PATH = join(homedir(), '.coral', 'history.jsonl')

// save original content & restore after tests
let originalContent: string | null = null
let backedUp = false

function ensureBackup(): void
{
  if (backedUp) return
  backedUp = true
  if (existsSync(HISTORY_PATH))
  {
    originalContent = readFileSync(HISTORY_PATH, 'utf-8')
  }
}

afterEach(() =>
{
  // clean up after each test so they don't interfere
  if (existsSync(HISTORY_PATH))
  {
    unlinkSync(HISTORY_PATH)
  }
})

after(() =>
{
  // restore original history file
  if (originalContent !== null)
  {
    mkdirSync(join(homedir(), '.coral'), { recursive: true })
    writeFileSync(HISTORY_PATH, originalContent, 'utf-8')
  }
})

// ── persistence tests ─────────────────────────────────────────────────

test('loadHistory returns empty array when file does not exist', () =>
{
  ensureBackup()
  if (existsSync(HISTORY_PATH)) unlinkSync(HISTORY_PATH)

  const entries = loadHistory()
  assert.deepEqual(entries, [])
})

test('appendHistoryEntry creates file & writes entry', () =>
{
  ensureBackup()

  const entry: HistoryEntry = {
    text: 'hello world',
    timestamp: 1000,
    sessionId: 'abc12345',
  }

  appendHistoryEntry(entry)

  assert.ok(existsSync(HISTORY_PATH))

  const entries = loadHistory()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.text, 'hello world')
  assert.equal(entries[0]!.timestamp, 1000)
  assert.equal(entries[0]!.sessionId, 'abc12345')
})

test('loadHistory reads back multiple entries in order', () =>
{
  ensureBackup()

  appendHistoryEntry({ text: 'first', timestamp: 1, sessionId: null })
  appendHistoryEntry({ text: 'second', timestamp: 2, sessionId: null })
  appendHistoryEntry({ text: 'third', timestamp: 3, sessionId: null })

  const entries = loadHistory()
  assert.equal(entries.length, 3)
  assert.equal(entries[0]!.text, 'first')
  assert.equal(entries[1]!.text, 'second')
  assert.equal(entries[2]!.text, 'third')
})

test('loadHistory skips corrupt JSONL lines', () =>
{
  ensureBackup()
  mkdirSync(join(homedir(), '.coral'), { recursive: true })

  const content = [
    JSON.stringify({ text: 'good one', timestamp: 1, sessionId: null }),
    'this is not json',
    '{"broken": true}',
    JSON.stringify({ text: 'good two', timestamp: 2, sessionId: null }),
  ].join('\n') + '\n'

  writeFileSync(HISTORY_PATH, content, 'utf-8')

  const entries = loadHistory()
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.text, 'good one')
  assert.equal(entries[1]!.text, 'good two')
})

test('loadHistory handles null sessionId gracefully', () =>
{
  ensureBackup()
  mkdirSync(join(homedir(), '.coral'), { recursive: true })

  const content = JSON.stringify({ text: 'test', timestamp: 1 }) + '\n'
  writeFileSync(HISTORY_PATH, content, 'utf-8')

  const entries = loadHistory()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.sessionId, null)
})

// ── navigation state machine tests ────────────────────────────────────

const sampleEntries: HistoryEntry[] = [
  { text: 'first', timestamp: 1, sessionId: null },
  { text: 'second', timestamp: 2, sessionId: null },
  { text: 'third', timestamp: 3, sessionId: null },
]

test('computeNavigateUp from draft (-1) returns last entry & stashes draft', () =>
{
  const result = computeNavigateUp(sampleEntries, -1, 'my draft', '')

  assert.equal(result.index, 2)
  assert.equal(result.text, 'third')
  assert.equal(result.draft, 'my draft')
})

test('computeNavigateUp from last entry returns second-to-last', () =>
{
  const result = computeNavigateUp(sampleEntries, 2, '', 'draft')

  assert.equal(result.index, 1)
  assert.equal(result.text, 'second')
})

test('computeNavigateUp at index 0 returns null (already at oldest)', () =>
{
  const result = computeNavigateUp(sampleEntries, 0, '', 'draft')

  assert.equal(result.index, 0)
  assert.equal(result.text, null)
})

test('computeNavigateUp with empty entries returns null', () =>
{
  const result = computeNavigateUp([], -1, 'draft', '')

  assert.equal(result.index, -1)
  assert.equal(result.text, null)
})

test('computeNavigateDown from index 0 returns entry at index 1', () =>
{
  const result = computeNavigateDown(sampleEntries, 0, 'draft')

  assert.equal(result.index, 1)
  assert.equal(result.text, 'second')
})

test('computeNavigateDown past last entry restores draft & resets index', () =>
{
  const result = computeNavigateDown(sampleEntries, 2, 'my draft')

  assert.equal(result.index, -1)
  assert.equal(result.text, 'my draft')
})

test('computeNavigateDown when already at draft (-1) returns null', () =>
{
  const result = computeNavigateDown(sampleEntries, -1, 'draft')

  assert.equal(result.index, -1)
  assert.equal(result.text, null)
})

test('full navigation cycle: up to oldest, then down to draft', () =>
{
  // start at draft
  let state = { index: -1, draft: '' }

  // navigate up to third (newest)
  let result = computeNavigateUp(sampleEntries, state.index, 'current', state.draft)
  assert.equal(result.text, 'third')
  state = { index: result.index, draft: result.draft }

  // navigate up to second
  result = computeNavigateUp(sampleEntries, state.index, '', state.draft)
  assert.equal(result.text, 'second')
  state = { index: result.index, draft: result.draft }

  // navigate up to first
  result = computeNavigateUp(sampleEntries, state.index, '', state.draft)
  assert.equal(result.text, 'first')
  state = { index: result.index, draft: result.draft }

  // at oldest — returns null
  result = computeNavigateUp(sampleEntries, state.index, '', state.draft)
  assert.equal(result.text, null)

  // navigate down to second
  let downResult = computeNavigateDown(sampleEntries, state.index, state.draft)
  assert.equal(downResult.text, 'second')
  state.index = downResult.index

  // navigate down to third
  downResult = computeNavigateDown(sampleEntries, state.index, state.draft)
  assert.equal(downResult.text, 'third')
  state.index = downResult.index

  // navigate down past newest — restores draft
  downResult = computeNavigateDown(sampleEntries, state.index, state.draft)
  assert.equal(downResult.index, -1)
  assert.equal(downResult.text, 'current')
})

test('computeNavigateUp with single entry works correctly', () =>
{
  const single: HistoryEntry[] = [{ text: 'only', timestamp: 1, sessionId: null }]

  const up = computeNavigateUp(single, -1, '', '')
  assert.equal(up.index, 0)
  assert.equal(up.text, 'only')

  // already at oldest
  const up2 = computeNavigateUp(single, 0, '', '')
  assert.equal(up2.text, null)

  // down restores draft
  const down = computeNavigateDown(single, 0, 'draft')
  assert.equal(down.index, -1)
  assert.equal(down.text, 'draft')
})
