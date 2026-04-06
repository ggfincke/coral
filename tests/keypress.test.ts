// tests/keypress.test.ts
// regression tests for mac-first terminal key parsing

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseKeypress } from '../src/tui/keypress.js'

test('parseKeypress maps the mac Delete key to backward delete', () =>
{
  const key = parseKeypress('\x7f')

  assert.equal(key.name, 'backspace')
  assert.equal(key.meta, false)
})

test('parseKeypress keeps Option+Delete on the backward-delete path', () =>
{
  const key = parseKeypress('\x1b\x7f')

  assert.equal(key.name, 'backspace')
  assert.equal(key.meta, true)
})

test('parseKeypress keeps Fn+Delete on the forward-delete path', () =>
{
  const key = parseKeypress('\x1b[3~')

  assert.equal(key.name, 'delete')
  assert.equal(key.meta, false)
})

test('parseKeypress decodes meta arrow modifiers like Claude Code', () =>
{
  const key = parseKeypress('\x1b[1;3D')

  assert.equal(key.name, 'left')
  assert.equal(key.meta, true)
  assert.equal(key.ctrl, false)
})

test('parseKeypress handles iTerm natural text editing word movement', () =>
{
  const left = parseKeypress('\x1Bb')
  const right = parseKeypress('\x1Bf')

  assert.equal(left.name, 'left')
  assert.equal(left.meta, true)
  assert.equal(right.name, 'right')
  assert.equal(right.meta, true)
})
