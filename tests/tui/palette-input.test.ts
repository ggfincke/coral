// tests/tui/palette-input.test.ts
// command palette ranking/viewport and high-impact key parsing

import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import stripAnsi from 'strip-ansi'
import { parseKeypress } from '../../src/tui/input/keypress.js'
import {
  buildPaletteEntries,
  buildPaletteLines,
  filterPaletteEntries,
  reducePaletteInput,
} from '../../src/tui/palette/palette.js'
import type { CommandInfo } from '../../src/tui/commands/contracts.js'
import type { KeybindingSummary } from '../../src/tui/input/keybindings.js'

describe('command palette', () =>
{
  const commands: CommandInfo[] = [
    { name: 'status', aliases: [], description: 'Show status' },
    { name: 'sessions', aliases: ['ls'], description: 'List sessions' },
    { name: 'permissions', aliases: ['perm'], description: 'Set permissions' },
  ]

  const keybindings: KeybindingSummary[] = [
    {
      keys: 'ctrl+p',
      description: 'Open command palette',
    },
    {
      keys: 'ctrl+y',
      description: 'Toggle permission mode',
      action: 'toggle-permissions',
    },
  ]

  const plain = (lines: string[]) => stripAnsi(lines.join('\n'))

  test('filterPaletteEntries ranks names, aliases, and keybindings', () =>
  {
    const entries = buildPaletteEntries(commands, keybindings)

    assert.deepEqual(
      filterPaletteEntries(entries, 'sta').map((entry) => entry.title),
      ['/status']
    )
    assert.deepEqual(
      filterPaletteEntries(entries, 'ls').map((entry) => entry.title),
      ['/sessions']
    )
    assert.deepEqual(
      filterPaletteEntries(entries, 'ctrl').map((entry) => entry.title),
      ['ctrl+p', 'ctrl+y']
    )
  })

  test('reducePaletteInput types literal j and k while arrows navigate', () =>
  {
    assert.deepEqual(
      reducePaletteInput({ query: '', selectedIndex: 2 }, 'j', {}, 4),
      { handled: true, state: { query: 'j', selectedIndex: 0 } }
    )
    assert.deepEqual(
      reducePaletteInput({ query: 'j', selectedIndex: 0 }, 'k', {}, 4),
      { handled: true, state: { query: 'jk', selectedIndex: 0 } }
    )
    assert.deepEqual(
      reducePaletteInput(
        { query: 'jk', selectedIndex: 1 },
        '',
        { upArrow: true },
        4
      ),
      { handled: true, state: { query: 'jk', selectedIndex: 0 } }
    )
    assert.deepEqual(
      reducePaletteInput(
        { query: 'jk', selectedIndex: 0 },
        '',
        { downArrow: true },
        4
      ),
      { handled: true, state: { query: 'jk', selectedIndex: 1 } }
    )
  })

  test('buildPaletteLines keeps the selected entry visible in short viewports', () =>
  {
    const entries = buildPaletteEntries(commands, keybindings)
    const lines = buildPaletteLines({
      entries,
      query: '',
      selectedIndex: entries.length - 1,
      width: 36,
      height: 4,
    })
    const rendered = plain(lines)

    assert.match(rendered, /› ctrl\+y/)
    assert.doesNotMatch(rendered, /› \/status/)
  })
})

describe('keypress parsing', () =>
{
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
})
