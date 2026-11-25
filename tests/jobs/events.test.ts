// tests/jobs/events.test.ts
// keep the coalesced task event log identical to whole-file bounded appends

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  appendJobEvent,
  flushJobEvents,
  jobDirectory,
} from '../../src/jobs/store.js'
import type { JobEvent } from '../../src/jobs/types.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { makeTempDirPool } from '../helpers/temp.js'

const pool = makeTempDirPool({ autoCleanup: false })
const restoreHome = captureCoralHome()
after(async () =>
{
  restoreHome()
  await pool.cleanup()
})

// eviction drops the oldest events and both bounds only grow with length, so
// the log after any append sequence is the longest suffix of all events that
// fits; find it by serializing whole candidate logs
function boundedReference(texts: string[]): JobEvent[]
{
  const at = new Date(0).toISOString()
  const events: JobEvent[] = texts.map((text, index) => ({
    sequence: index + 1,
    at,
    type: 'token',
    text,
  }))
  const fits = (start: number) =>
    events.length - start === 1 ||
    (events.length - start <= 2048 &&
      Buffer.byteLength(JSON.stringify(events.slice(start), null, 2)) <=
        2 * 1024 * 1024)
  let low = 0
  let high = events.length - 1
  while (low < high)
  {
    const middle = Math.floor((low + high) / 2)
    if (fits(middle)) high = middle
    else low = middle + 1
  }
  return events.slice(low)
}

test('coalesced appends match the bounded log without rereading the file', async () =>
{
  const root = await pool.tempDir('coral-job-events-')
  process.env.CORAL_HOME = join(root, 'home')
  const id = 'abcd1234'
  const path = join(jobDirectory(id), 'events.json')
  // small events first pass the count bound; about 1 KiB events then pass the
  // byte bound with a fine-grained cut. multibyte text separates bytes & chars
  const texts = Array.from({ length: 4400 }, (_, index) =>
    index < 2100
      ? `é ${index} `.repeat((index % 3) + 1)
      : `é token ${index} `.repeat(70 + (index % 9))
  )
  appendJobEvent(id, 'token', texts[0])
  const persisted = readFileSync(path, 'utf8')
  // coalesced appends must not read the log; a read would fail on this
  writeFileSync(path, JSON.stringify({ invalid: true }))
  for (const text of texts.slice(1))
    appendJobEvent(id, 'token', text, { coalesce: true })
  // the flush reads the file once
  writeFileSync(path, persisted)
  flushJobEvents(id)

  const written = JSON.parse(readFileSync(path, 'utf8')) as JobEvent[]
  const expected = boundedReference(texts)
  assert.ok(expected.length < 2048, 'the fixture must reach the byte bound')
  assert.deepEqual(
    written.map(({ sequence, type, text }) => ({ sequence, type, text })),
    expected.map(({ sequence, type, text }) => ({ sequence, type, text }))
  )
})
