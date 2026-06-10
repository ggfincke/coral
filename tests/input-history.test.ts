// tests/input-history.test.ts
// tests for input history persistence & navigation state machine

import { strict as assert } from 'node:assert'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, beforeEach, test } from 'node:test'

import {
  loadHistory,
  appendHistoryEntry,
  computeNavigateUp,
  computeNavigateDown,
  type HistoryEntry,
} from '../src/tui/input-history.js'

const tempDirs: string[] = []
const originalCoralHome = process.env.CORAL_HOME

function historyPath(): string
{
  return join(process.env.CORAL_HOME!, 'history.jsonl')
}

beforeEach(() =>
{
  const dir = mkdtempSync(join(tmpdir(), 'coral-history-'))
  tempDirs.push(dir)
  process.env.CORAL_HOME = dir
})

after(() =>
{
  if (originalCoralHome === undefined)
  {
    delete process.env.CORAL_HOME
  }
  else
  {
    process.env.CORAL_HOME = originalCoralHome
  }

  for (const dir of tempDirs)
  {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── persistence tests ─────────────────────────────────────────────────

test('loadHistory returns empty array when file does not exist', () =>
{
  const entries = loadHistory()
  assert.deepEqual(entries, [])
})

test('appendHistoryEntry creates file & writes entry', () =>
{
  const entry: HistoryEntry = {
    text: 'hello world',
    timestamp: 1000,
    sessionId: 'abc12345',
  }

  appendHistoryEntry(entry)

  assert.ok(existsSync(historyPath()))

  const entries = loadHistory()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.text, 'hello world')
  assert.equal(entries[0]!.timestamp, 1000)
  assert.equal(entries[0]!.sessionId, 'abc12345')
})

test('loadHistory reads back multiple entries in order', () =>
{
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
  const path = historyPath()
  mkdirSync(join(path, '..'), { recursive: true })

  const content =
    [
      JSON.stringify({ text: 'good one', timestamp: 1, sessionId: null }),
      'this is not json',
      '{"broken": true}',
      JSON.stringify({ text: 'good two', timestamp: 2, sessionId: null }),
    ].join('\n') + '\n'

  writeFileSync(path, content, 'utf-8')

  const entries = loadHistory()
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.text, 'good one')
  assert.equal(entries[1]!.text, 'good two')
})

test('loadHistory handles null sessionId gracefully', () =>
{
  const path = historyPath()
  mkdirSync(join(path, '..'), { recursive: true })

  const content = JSON.stringify({ text: 'test', timestamp: 1 }) + '\n'
  writeFileSync(path, content, 'utf-8')

  const entries = loadHistory()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.sessionId, null)
})

test('appendHistoryEntry trims the history file to MAX_ENTRIES', () =>
{
  for (let i = 0; i < 505; i++)
  {
    appendHistoryEntry({
      text: `entry ${i}`,
      timestamp: i,
      sessionId: null,
    })
  }

  const entries = loadHistory()

  assert.equal(entries.length, 500)
  assert.equal(entries[0]!.text, 'entry 5')
  assert.equal(entries.at(-1)!.text, 'entry 504')
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
  let result = computeNavigateUp(
    sampleEntries,
    state.index,
    'current',
    state.draft
  )
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
  const single: HistoryEntry[] = [
    { text: 'only', timestamp: 1, sessionId: null },
  ]

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
