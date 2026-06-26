// tests/utils/bytes.test.ts
// coverage for human-readable byte formatting

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { formatBytes } from '../../src/utils/bytes.js'

test('formatBytes uses byte tier w/o decimals', () =>
{
  assert.equal(formatBytes(512), '512 B')
})

test('formatBytes scales through binary units w/ one decimal', () =>
{
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1_048_576), '1.0 MB')
})

test('formatBytes can omit the unit separator', () =>
{
  assert.equal(formatBytes(1024, { space: false }), '1.0KB')
})
