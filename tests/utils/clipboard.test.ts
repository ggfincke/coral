// tests/utils/clipboard.test.ts
// tests for OSC 52 encoding, tmux wrapping, & transport selection inputs

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  encodeOsc52,
  inTmux,
  isItermTerminal,
  overSsh,
  tmuxLoadBufferArgs,
  wrapOsc52ForTmux,
} from '../../src/utils/clipboard.js'

test('encodeOsc52 base64-encodes utf-8 text', () =>
{
  const sequence = encodeOsc52('hi')
  assert.equal(sequence, '\u001b]52;c;aGk=\u0007')
  // multibyte content survives round-trip through the base64 body
  const body = encodeOsc52('中文').slice(
    '\u001b]52;c;'.length,
    -'\u0007'.length
  )
  assert.equal(Buffer.from(body, 'base64').toString('utf-8'), '中文')
})

test('wrapOsc52ForTmux doubles inner escapes inside a DCS frame', () =>
{
  const raw = encodeOsc52('hi')
  const wrapped = wrapOsc52ForTmux(raw)
  assert.ok(wrapped.startsWith('\u001bPtmux;'))
  assert.ok(wrapped.endsWith('\u001b\\'))
  const inner = wrapped.slice('\u001bPtmux;'.length, -'\u001b\\'.length)
  // every ESC inside the payload doubled exactly once
  assert.equal(inner, '\u001b\u001b]52;c;aGk=\u0007')
})

test('env detection drives transport selection', () =>
{
  assert.equal(inTmux({ TMUX: '/tmp/tmux-0/default,1,0' }), true)
  assert.equal(inTmux({}), false)

  assert.equal(overSsh({ SSH_CONNECTION: '1 2 3 4' }), true)
  assert.equal(overSsh({}), false)

  assert.equal(isItermTerminal({ LC_TERMINAL: 'iTerm2' }), true)
  assert.equal(isItermTerminal({ LC_TERMINAL: 'WezTerm' }), false)
})

test('-w is dropped from load-buffer under iTerm2', () =>
{
  assert.deepEqual(tmuxLoadBufferArgs({ LC_TERMINAL: 'iTerm2' }), [
    'load-buffer',
    '-',
  ])
  assert.deepEqual(tmuxLoadBufferArgs({ LC_TERMINAL: 'WezTerm' }), [
    'load-buffer',
    '-w',
    '-',
  ])
})
