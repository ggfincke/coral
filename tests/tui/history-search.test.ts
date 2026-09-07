// tests/tui/history-search.test.ts
// tests for ctrl+r reverse-search over prompt history

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  cycleHistorySearchMatch,
  findHistoryMatchIndex,
  historySearchPreview,
  IDLE_HISTORY_SEARCH,
  startHistorySearch,
  updateHistorySearchQuery,
} from '../../src/tui/prompt/history-search.js'

const ENTRIES = [
  { text: 'oldest grep task' },
  { text: 'fix the Grep loop' },
  { text: 'grep the config' },
  { text: 'newest unrelated' },
]

test('findHistoryMatchIndex scans newest-first, case-insensitive', () =>
{
  assert.equal(findHistoryMatchIndex(ENTRIES, 'grep'), 2)
  assert.equal(findHistoryMatchIndex(ENTRIES, 'GREP'), 2)
  assert.equal(findHistoryMatchIndex(ENTRIES, 'loop'), 1)
  assert.equal(findHistoryMatchIndex(ENTRIES, 'missing'), -1)
  // an empty query never matches
  assert.equal(findHistoryMatchIndex(ENTRIES, ''), -1)
})

test('fromExclusive skips newer entries so cycling walks older ones', () =>
{
  assert.equal(findHistoryMatchIndex(ENTRIES, 'grep', 2), 1)
  assert.equal(findHistoryMatchIndex(ENTRIES, 'grep', 1), 0)
  // exhausted: nothing older remains
  assert.equal(findHistoryMatchIndex(ENTRIES, 'grep', 0), -1)
})

test('update resets to the newest match; cycling advances & clamps', () =>
{
  let state = startHistorySearch()
  state = updateHistorySearchQuery(ENTRIES, state, 'grep')
  assert.equal(state.matchIndex, 2)

  state = cycleHistorySearchMatch(ENTRIES, state)
  assert.equal(state.matchIndex, 1)

  state = cycleHistorySearchMatch(ENTRIES, state)
  assert.equal(state.matchIndex, 0)

  // exhausted: stays on the oldest match instead of jumping away
  const stuck = cycleHistorySearchMatch(ENTRIES, state)
  assert.equal(stuck.matchIndex, 0)
})

test('preview shows the matched text only while active', () =>
{
  const state = updateHistorySearchQuery(
    ENTRIES,
    startHistorySearch(),
    'config'
  )
  assert.equal(historySearchPreview(ENTRIES, state), 'grep the config')

  // idle states never preview even w/ a stale match index
  const idle = { ...IDLE_HISTORY_SEARCH, matchIndex: 2 }
  assert.equal(historySearchPreview(ENTRIES, idle), null)
})

test('shortening the query re-finds from the newest match', () =>
{
  let state = updateHistorySearchQuery(
    ENTRIES,
    startHistorySearch(),
    'grep the c'
  )
  assert.equal(state.matchIndex, 2)

  state = updateHistorySearchQuery(ENTRIES, state, 'grep t')
  // newest entry containing 'grep t' is index 2 ('grep the config')
  assert.equal(state.matchIndex, 2)

  state = updateHistorySearchQuery(ENTRIES, state, 'zzz')
  assert.equal(state.matchIndex, -1)
})
