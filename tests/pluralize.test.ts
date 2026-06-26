// tests/pluralize.test.ts
// coverage for count-prefixed noun pluralization

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pluralize } from '../src/utils/pluralize.js'

test('pluralize uses singular for one', () =>
{
  assert.equal(pluralize(1, 'block'), '1 block')
})

test('pluralize appends s for other counts', () =>
{
  assert.equal(pluralize(0, 'item'), '0 items')
  assert.equal(pluralize(2, 'occurrence'), '2 occurrences')
})

test('pluralize accepts an explicit plural form', () =>
{
  assert.equal(pluralize(2, 'match', 'matches'), '2 matches')
})
