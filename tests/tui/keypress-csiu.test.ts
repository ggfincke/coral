// tests/tui/keypress-csiu.test.ts
// kitty CSI-u parsing in the shared keypress decoder

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseKeypress } from '../../src/tui/input/keypress.js'

test('CSI-u maps functional codepoints onto existing key names', () =>
{
  const enter = parseKeypress('\x1b[13u')
  assert.equal(enter.name, 'return')
  assert.equal(enter.ctrl, false)
  assert.equal(enter.meta, false)
  assert.equal(enter.shift, false)

  const escape = parseKeypress('\x1b[27u')
  assert.equal(escape.name, 'escape')

  const tab = parseKeypress('\x1b[9u')
  assert.equal(tab.name, 'tab')

  const backspace = parseKeypress('\x1b[127u')
  assert.equal(backspace.name, 'backspace')

  // alternate kitty functional codepoints
  assert.equal(parseKeypress('\x1b[57414u').name, 'return')
  assert.equal(parseKeypress('\x1b[57427u').name, 'escape')
  assert.equal(parseKeypress('\x1b[57425u').name, 'tab')
})

test('CSI-u decodes kitty modifiers+1 bitfield', () =>
{
  // kitty sends mods+1, so a plain key encodes 1 -> no modifiers
  const plainMods = parseKeypress('\x1b[13;1u')
  assert.equal(plainMods.name, 'return')
  assert.equal(plainMods.shift, false)
  assert.equal(plainMods.meta, false)
  assert.equal(plainMods.ctrl, false)

  const shiftA = parseKeypress('\x1b[97;2u')
  assert.equal(shiftA.name, '')
  assert.equal(shiftA.sequence, 'a')
  assert.equal(shiftA.shift, true)

  const altA = parseKeypress('\x1b[97;3u')
  assert.equal(altA.meta, true)
  assert.equal(altA.shift, false)

  const ctrlA = parseKeypress('\x1b[97;5u')
  assert.equal(ctrlA.ctrl, true)
  assert.equal(ctrlA.meta, false)

  const ctrlEnter = parseKeypress('\x1b[13;5u')
  assert.equal(ctrlEnter.name, 'return')
  assert.equal(ctrlEnter.ctrl, true)
})

test('CSI-u shifted-codepoint shape ignores the shifted field', () =>
{
  const shiftedCtrlA = parseKeypress('\x1b[97:98;5u')
  assert.equal(shiftedCtrlA.name, '')
  assert.equal(shiftedCtrlA.sequence, 'a')
  assert.equal(shiftedCtrlA.ctrl, true)
  assert.equal(shiftedCtrlA.shift, false)
})

test('CSI-u printable codepoints insert like typed chars', () =>
{
  const x = parseKeypress('\x1b[120;1u')
  assert.equal(x.name, '')
  assert.equal(x.sequence, 'x')

  const upperX = parseKeypress('\x1b[88;2u')
  assert.equal(upperX.name, '')
  assert.equal(upperX.sequence, 'X')
  assert.equal(upperX.shift, true)
})

test('CSI-u malformed or partial sequences stay unconsumed', () =>
{
  const partial = parseKeypress('\x1b[13')
  assert.equal(partial.name, '')
  assert.equal(partial.sequence, '\x1b[13')

  const missingCodepoint = parseKeypress('\x1b[u')
  assert.equal(missingCodepoint.name, '')
  assert.equal(missingCodepoint.sequence, '\x1b[u')

  const outOfRange = parseKeypress('\x1b[9999999999u')
  assert.equal(outOfRange.name, '')
  assert.equal(outOfRange.sequence, '\x1b[9999999999u')
})

test('existing fixed-shape parsing is unaffected by CSI-u support', () =>
{
  assert.equal(parseKeypress('\r').name, 'return')
  assert.equal(parseKeypress('\t').name, 'tab')
  assert.equal(parseKeypress('\x7f').name, 'backspace')
  assert.equal(parseKeypress('\x1b\x7f').name, 'backspace')
  assert.equal(parseKeypress('\x1b').name, 'escape')
  assert.equal(parseKeypress('\x1b[3~').name, 'delete')
  assert.equal(parseKeypress('a').name, 'a')
})
