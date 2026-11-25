// tests/telemetry/telemetry.test.ts
// per-model reliability telemetry: counter math & on-disk round trip

import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  makeReliabilityStats,
  type ReliabilityStats,
} from '../../src/types/inference.js'
import {
  addReliability,
  loadTelemetry,
  recordReliability,
} from '../../src/telemetry/store.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

test('telemetry model maps safely retain prototype-like model names', async () =>
{
  const dir = await tempDir('coral-telemetry-prototype-')
  const path = join(dir, 'telemetry.json')
  recordReliability(
    '__proto__',
    makeReliabilityStats({ editRepairs: 2 }),
    '2026-06-22T00:00:00.000Z',
    path
  )
  const loaded = loadTelemetry(path)
  assert.equal(Object.getPrototypeOf(loaded.models), null)
  assert.equal(loaded.models['__proto__']?.reliability.editRepairs, 2)
})

test('v1 telemetry events default missing counters and bind UUID to filename', async () =>
{
  const dir = await tempDir('coral-telemetry-event-')
  const path = join(dir, 'telemetry.json')
  const eventsDir = join(dir, 'telemetry.d')
  await mkdir(eventsDir)

  const acceptedId = randomUUID()
  await writeFile(
    join(eventsDir, `${acceptedId}.json`),
    JSON.stringify({
      version: 1,
      id: acceptedId,
      model: 'partial-v1',
      reliability: { reprompts: 2 },
      recordedAt: '2026-06-21T00:00:00.000Z',
    }),
    'utf-8'
  )

  const mismatchedFilenameId = randomUUID()
  const mismatchedId =
    (mismatchedFilenameId[0] === '0' ? '1' : '0') +
    mismatchedFilenameId.slice(1)
  await writeFile(
    join(eventsDir, `${mismatchedFilenameId}.json`),
    JSON.stringify({
      version: 1,
      id: mismatchedId,
      model: 'partial-v1',
      reliability: { reprompts: 100 },
      recordedAt: '2026-06-22T00:00:00.000Z',
    }),
    'utf-8'
  )

  const invalidId = randomUUID()
  await writeFile(
    join(eventsDir, `${invalidId}.json`),
    JSON.stringify({
      version: 1,
      id: invalidId,
      model: 'partial-v1',
      reliability: { reprompts: '2' },
      recordedAt: '2026-06-23T00:00:00.000Z',
    }),
    'utf-8'
  )

  const record = loadTelemetry(path).models['partial-v1']
  assert.equal(record?.sessions, 1)
  assert.equal(record?.reliability.reprompts, 2)
  assert.equal(record?.reliability.editRepairs, 0)
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

test('telemetry append avoids historical reads and explicit loading merges immutable records', async (t) =>
{
  const dir = await tempDir('coral-telemetry-')
  const path = join(dir, 'telemetry.json')

  const reads = t.mock.method(fs, 'readFileSync')
  const listings = t.mock.method(fs, 'readdirSync')
  syncBuiltinESMExports()
  try
  {
    recordReliability(
      'gemma',
      makeReliabilityStats({ doomLoopTrips: 1 }),
      '2026-06-23T00:00:00.000Z',
      path
    )
    recordReliability(
      'gemma',
      makeReliabilityStats({ doomLoopTrips: 2 }),
      '2026-06-22T00:00:00.000Z',
      path
    )
    assert.equal(reads.mock.callCount(), 0)
    assert.equal(listings.mock.callCount(), 0)
  }
  finally
  {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }

  const eventsDir = join(dir, 'telemetry.d')
  const eventFiles = await readdir(eventsDir)
  const duplicateBytes = await readFile(
    join(eventsDir, eventFiles[0]!),
    'utf-8'
  )
  await writeFile(
    join(eventsDir, `${randomUUID()}.json`),
    duplicateBytes,
    'utf-8'
  )
  const loaded = loadTelemetry(path)
  const record = loaded.models['gemma']

  assert.equal(eventFiles.length, 2)
  assert.equal(record?.sessions, 2)
  assert.equal(record?.reliability.doomLoopTrips, 3)
  assert.equal(record?.firstSeen, '2026-06-22T00:00:00.000Z')
  assert.equal(record?.updatedAt, '2026-06-23T00:00:00.000Z')

  const invalidCountersId = randomUUID()
  await writeFile(
    join(eventsDir, `${invalidCountersId}.json`),
    JSON.stringify({
      version: 1,
      id: invalidCountersId,
      model: 'gemma',
      reliability: makeReliabilityStats({ doomLoopTrips: -100 }),
      recordedAt: '2026-06-24T00:00:00.000Z',
    }),
    'utf-8'
  )
  await writeFile(join(eventsDir, `${randomUUID()}.json`), '{', 'utf-8')
  await writeFile(join(eventsDir, '.interrupted.tmp'), '{', 'utf-8')

  assert.deepEqual(loadTelemetry(path), loaded)

  if (process.platform !== 'win32')
  {
    assert.equal((await stat(eventsDir)).mode & 0o777, 0o700)
    assert.equal(
      (await stat(join(eventsDir, eventFiles[0]!))).mode & 0o777,
      0o600
    )
  }
})
