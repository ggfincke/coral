// tests/telemetry.test.ts
// per-model reliability telemetry: fold math & on-disk round trip

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ReliabilityStats } from '../src/agent/agent.js'
import {
  addReliability,
  foldReliability,
  loadTelemetry,
  recordReliability,
  type TelemetryStore,
} from '../src/telemetry/store.js'

const tempDirs: string[] = []

after(async () =>
{
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

// build a stats object, overriding any subset of counters onto a zero baseline
function stats(overrides: Partial<ReliabilityStats> = {}): ReliabilityStats
{
  return {
    repairedToolCalls: 0,
    nameRepairs: 0,
    stallNudges: 0,
    validationFailures: 0,
    editRepairs: 0,
    doomLoopTrips: 0,
    reprompts: 0,
    verifyFlags: 0,
    verifyReprompts: 0,
    ...overrides,
  }
}

const EMPTY: TelemetryStore = { version: 1, models: {} }

test('foldReliability seeds a new model record', () =>
{
  const next = foldReliability(
    EMPTY,
    'gemma',
    stats({ editRepairs: 2, reprompts: 1 }),
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
    stats({ editRepairs: 2 }),
    '2026-06-21T00:00:00.000Z'
  )
  const second = foldReliability(
    first,
    'gemma',
    stats({ editRepairs: 3, nameRepairs: 1 }),
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
  let store = foldReliability(EMPTY, 'gemma', stats({ reprompts: 1 }), 't1')
  store = foldReliability(store, 'qwen', stats({ reprompts: 5 }), 't2')
  assert.equal(store.models['gemma']?.reliability.reprompts, 1)
  assert.equal(store.models['qwen']?.reliability.reprompts, 5)
})

test('addReliability coerces a corrupt on-disk base to zero', () =>
{
  // a stale record missing a counter must not poison the sum w/ NaN
  const corrupt = { editRepairs: 4 } as unknown as ReliabilityStats
  const sum = addReliability(corrupt, stats({ editRepairs: 1, reprompts: 2 }))
  assert.equal(sum.editRepairs, 5)
  assert.equal(sum.reprompts, 2)
})

test('recordReliability round-trips through disk', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-telemetry-'))
  tempDirs.push(dir)
  const path = join(dir, 'telemetry.json')

  recordReliability('gemma', stats({ doomLoopTrips: 1 }), 't1', path)
  recordReliability('gemma', stats({ doomLoopTrips: 2 }), 't2', path)

  const loaded = loadTelemetry(path)
  assert.equal(loaded.models['gemma']?.sessions, 2)
  assert.equal(loaded.models['gemma']?.reliability.doomLoopTrips, 3)
})
