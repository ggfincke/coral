// tests/use-coral-input.test.ts
// regression tests for Coral's shared terminal input parsing

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  parseMouseWheelPacket,
  tokenizeTerminalChunk,
} from '../src/tui/use-coral-input.js'

test('parseMouseWheelPacket detects wheel up & down SGR packets', () =>
{
  assert.equal(parseMouseWheelPacket('\x1b[<64;20;38M'), 'up')
  assert.equal(parseMouseWheelPacket('\x1b[<65;20;38M'), 'down')
  assert.equal(parseMouseWheelPacket('\x1b[<0;20;38M'), 'other')
  assert.equal(parseMouseWheelPacket('hello'), null)
})

test('tokenizeTerminalChunk splits text from wheel packets', () =>
{
  const result = tokenizeTerminalChunk('hello\x1b[<64;20;38Mworld')

  assert.deepEqual(result, {
    tokens: ['hello', '\x1b[<64;20;38M', 'world'],
    pending: '',
  })
})

test('tokenizeTerminalChunk buffers incomplete mouse packets', () =>
{
  const result = tokenizeTerminalChunk('\x1b[<64;20;')

  assert.deepEqual(result, {
    tokens: [],
    pending: '\x1b[<64;20;',
  })
})
