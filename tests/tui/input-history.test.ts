// tests/tui/input-history.test.ts
// tests for input history persistence & navigation state

import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

import {
  loadHistory,
  appendHistoryEntry,
  computeNavigateUp,
  computeNavigateDown,
  type HistoryEntry,
} from '../../src/tui/prompt/input-history.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { captureCoralHome } from '../helpers/coral-home.js'

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

test('appendHistoryEntry persists privately and loadHistory returns a read-only tail', () =>
{
  for (let i = 0; i < 505; i++)
  {
    appendHistoryEntry({
      text: `entry ${i}`,
      timestamp: i,
      sessionId: i === 504 ? 'abc12345' : null,
    })
  }

  const beforeLoad = readFileSync(historyPath())
  const entries = loadHistory()
  const afterLoad = readFileSync(historyPath())

  assert.equal(entries.length, 500)
  assert.equal(entries[0]!.text, 'entry 5')
  assert.equal(entries.at(-1)!.text, 'entry 504')
  assert.equal(entries.at(-1)!.sessionId, 'abc12345')
  assert.deepEqual(afterLoad, beforeLoad)
  assert.equal(
    beforeLoad
      .toString('utf-8')
      .split('\n')
      .filter((line) => line.trim()).length,
    505
  )

  if (process.platform !== 'win32')
  {
    assert.equal(statSync(historyPath()).mode & 0o777, 0o600)
    assert.equal(statSync(process.env.CORAL_HOME!).mode & 0o777, 0o700)
  }
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

test('history appends recover after a truncated tail and bound corrupt records', () =>
{
  const path = historyPath()
  mkdirSync(join(path, '..'), { recursive: true })
  const oldEntry = JSON.stringify({
    text: 'good before corruption',
    timestamp: 1,
    sessionId: null,
  })
  writeFileSync(
    path,
    `${oldEntry}\n${'x'.repeat(1024 * 1024 + 1)}\n{"text":"truncated`,
    'utf-8'
  )

  appendHistoryEntry({
    text: 'good after crash',
    timestamp: 2,
    sessionId: 'deadbeef',
  })

  assert.deepEqual(loadHistory(), [
    { text: 'good before corruption', timestamp: 1, sessionId: null },
    { text: 'good after crash', timestamp: 2, sessionId: 'deadbeef' },
  ])
  assert.match(
    readFileSync(path, 'utf-8'),
    /\{"text":"truncated\n\{"text":"good after crash"/
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
