// tests/input-history.test.ts
// tests for input history persistence & navigation state

import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

import {
  loadHistory,
  appendHistoryEntry,
  computeNavigateUp,
  computeNavigateDown,
  type HistoryEntry,
} from '../src/tui/input-history.js'
import { makeTempDirPool } from './helpers/temp.js'
import { captureCoralHome } from './helpers/coral-home.js'

const { tempDirSync, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()

function historyPath(): string
{
  return join(process.env.CORAL_HOME!, 'history.jsonl')
}

beforeEach(() =>
{
  const dir = tempDirSync('coral-history-')
  process.env.CORAL_HOME = dir
})

after(async () =>
{
  restoreCoralHome()
  await cleanup()
})

test('appendHistoryEntry persists entries and trims old prompts', () =>
{
  for (let i = 0; i < 505; i++)
  {
    appendHistoryEntry({
      text: `entry ${i}`,
      timestamp: i,
      sessionId: i === 504 ? 'abc12345' : null,
    })
  }

  const entries = loadHistory()

  assert.equal(entries.length, 500)
  assert.equal(entries[0]!.text, 'entry 5')
  assert.equal(entries.at(-1)!.text, 'entry 504')
  assert.equal(entries.at(-1)!.sessionId, 'abc12345')
})

test('loadHistory skips corrupt JSONL rows without dropping valid prompts', () =>
{
  const path = historyPath()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    [
      JSON.stringify({ text: 'good one', timestamp: 1, sessionId: null }),
      'this is not json',
      '{"broken": true}',
      JSON.stringify({ text: 'good two', timestamp: 2, sessionId: null }),
    ].join('\n') + '\n',
    'utf-8'
  )

  const entries = loadHistory()

  assert.deepEqual(
    entries.map((entry) => entry.text),
    ['good one', 'good two']
  )
})

test('history navigation walks entries and restores the draft', () =>
{
  const entries: HistoryEntry[] = [
    { text: 'first', timestamp: 1, sessionId: null },
    { text: 'second', timestamp: 2, sessionId: null },
    { text: 'third', timestamp: 3, sessionId: null },
  ]

  const newest = computeNavigateUp(entries, -1, 'current draft', '')
  const older = computeNavigateUp(entries, newest.index, '', newest.draft)
  const oldest = computeNavigateUp(entries, older.index, '', older.draft)
  const towardSecond = computeNavigateDown(entries, oldest.index, oldest.draft)
  const towardThird = computeNavigateDown(
    entries,
    towardSecond.index,
    oldest.draft
  )
  const pastNewest = computeNavigateDown(
    entries,
    towardThird.index,
    oldest.draft
  )

  assert.equal(newest.text, 'third')
  assert.equal(older.text, 'second')
  assert.equal(oldest.text, 'first')
  assert.equal(pastNewest.index, -1)
  assert.equal(pastNewest.text, 'current draft')
})
