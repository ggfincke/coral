// tests/tui/palette.test.ts
// command palette ranking, selection, & line rendering

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import stripAnsi from 'strip-ansi'
import {
  buildPaletteEntries,
  buildPaletteLines,
  filterPaletteEntries,
  movePaletteSelection,
  reducePaletteInput,
} from '../../src/tui/palette.js'
import type {
  CommandInfo,
  KeybindingSummary,
} from '../../src/tui/shell/commands.js'

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

test('movePaletteSelection clamps to available rows', () =>
{
  assert.equal(movePaletteSelection(0, -1, 3), 0)
  assert.equal(movePaletteSelection(0, 1, 3), 1)
  assert.equal(movePaletteSelection(2, 1, 3), 2)
  assert.equal(movePaletteSelection(2, -1, 0), 0)
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

test('buildPaletteLines renders query, selected marker, and disabled hint', () =>
{
  const entries = buildPaletteEntries(commands, keybindings)
  const lines = buildPaletteLines({
    entries: filterPaletteEntries(entries, ''),
    query: 'perm',
    selectedIndex: 1,
    width: 72,
    height: 8,
  })
  const rendered = plain(lines)

  assert.match(rendered, /command palette ctrl\+p/)
  assert.match(rendered, /query: perm/)
  assert.match(rendered, /\/status/)
  assert.match(rendered, /\/sessions/)
  assert.match(rendered, /press key/)
})
