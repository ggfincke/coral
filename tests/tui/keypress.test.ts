// tests/tui/keypress.test.ts
// tests for high-impact terminal key parsing

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseKeypress } from '../../src/tui/hooks/keypress.js'

test('parseKeypress handles Mac delete variants correctly', () =>
{
  const backspace = parseKeypress('\x7f')
  const optionDelete = parseKeypress('\x1b\x7f')
  const forwardDelete = parseKeypress('\x1b[3~')

  assert.equal(backspace.name, 'backspace')
  assert.equal(backspace.meta, false)
  assert.equal(optionDelete.name, 'backspace')
  assert.equal(optionDelete.meta, true)
  assert.equal(forwardDelete.name, 'delete')
})

test('parseKeypress decodes word-navigation escape sequences', () =>
{
  const metaLeft = parseKeypress('\x1b[1;3D')
  const naturalLeft = parseKeypress('\x1Bb')
  const naturalRight = parseKeypress('\x1Bf')

  assert.equal(metaLeft.name, 'left')
  assert.equal(metaLeft.meta, true)
  assert.equal(naturalLeft.name, 'left')
  assert.equal(naturalLeft.meta, true)
  assert.equal(naturalRight.name, 'right')
  assert.equal(naturalRight.meta, true)
})
