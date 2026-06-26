// tests/telemetry.test.ts
// per-model reliability telemetry: fold math & on-disk round trip

import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  makeReliabilityStats,
  type ReliabilityStats,
} from '../src/types/inference.js'
import {
  addReliability,
  foldReliability,
  loadTelemetry,
  recordReliability,
  type TelemetryStore,
} from '../src/telemetry/store.js'
import { makeTempDirPool } from './helpers/temp.js'

const { tempDir } = makeTempDirPool()

const EMPTY: TelemetryStore = { models: {} }

test('foldReliability seeds a new model record', () =>
{
  const next = foldReliability(
    EMPTY,
    'gemma',
    makeReliabilityStats({ editRepairs: 2, reprompts: 1 }),
    '2026-06-21T00:00:00.000Z'
  )
  const record = next.models['gemma']
  assert.equal(record?.sessions, 1)
  assert.equal(record?.reliability.editRepairs, 2)
  assert.equal(record?.reliability.reprompts, 1)
  assert.equal(record?.firstSeen, '2026-06-21T00:00:00.000Z')
  assert.equal(record?.updatedAt, '2026-06-21T00:00:00.000Z')
})

test('foldReliability accumulates & preserves firstSeen', () =>
{
  const first = foldReliability(
    EMPTY,
    'gemma',
    makeReliabilityStats({ editRepairs: 2 }),
    '2026-06-21T00:00:00.000Z'
  )
  const second = foldReliability(
    first,
    'gemma',
    makeReliabilityStats({ editRepairs: 3, nameRepairs: 1 }),
    '2026-06-22T00:00:00.000Z'
  )
  const record = second.models['gemma']
  assert.equal(record?.sessions, 2)
  assert.equal(record?.reliability.editRepairs, 5)
  assert.equal(record?.reliability.nameRepairs, 1)
  // firstSeen sticks, updatedAt advances
  assert.equal(record?.firstSeen, '2026-06-21T00:00:00.000Z')
  assert.equal(record?.updatedAt, '2026-06-22T00:00:00.000Z')
})

test('foldReliability keeps models independent', () =>
{
  let store = foldReliability(
    EMPTY,
    'gemma',
    makeReliabilityStats({ reprompts: 1 }),
    't1'
  )
  store = foldReliability(
    store,
    'qwen',
    makeReliabilityStats({ reprompts: 5 }),
    't2'
  )
  assert.equal(store.models['gemma']?.reliability.reprompts, 1)
  assert.equal(store.models['qwen']?.reliability.reprompts, 5)
})

test('addReliability coerces a corrupt on-disk base to zero', () =>
{
  // a stale record missing a counter must not poison the sum w/ NaN
  const corrupt = { editRepairs: 4 } as unknown as ReliabilityStats
  const sum = addReliability(
    corrupt,
    makeReliabilityStats({ editRepairs: 1, reprompts: 2 })
  )
  assert.equal(sum.editRepairs, 5)
  assert.equal(sum.reprompts, 2)
})

test('recordReliability round-trips through disk', async () =>
{
  const dir = await tempDir('coral-telemetry-')
  const path = join(dir, 'telemetry.json')

  recordReliability(
    'gemma',
    makeReliabilityStats({ doomLoopTrips: 1 }),
    't1',
    path
  )
  recordReliability(
    'gemma',
    makeReliabilityStats({ doomLoopTrips: 2 }),
    't2',
    path
  )

  const loaded = loadTelemetry(path)
  assert.equal(loaded.models['gemma']?.sessions, 2)
  assert.equal(loaded.models['gemma']?.reliability.doomLoopTrips, 3)
})
