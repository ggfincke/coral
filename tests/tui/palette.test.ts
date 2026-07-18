// tests/tui/palette.test.ts
// command palette ranking, selection, & line rendering

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import stripAnsi from 'strip-ansi'
import {
  buildPaletteEntries,
  buildPaletteLines,
  filterPaletteEntries,
  reducePaletteInput,
} from '../../src/tui/palette/palette.js'
import type { CommandInfo } from '../../src/tui/commands/contracts.js'
import type { KeybindingSummary } from '../../src/tui/input/keybindings.js'

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
