// tests/tui/keybinding-config.test.ts
// tests for keybinding override parsing, chord normalization, & lookup builds

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildChordLookup,
  normalizeChord,
  parseKeybindingOverrides,
} from '../../src/tui/input/keybinding-config.js'

test('parse accepts arrays of well-formed overrides', () =>
{
  const raw = [
    { action: 'toggle-thinking', chord: 'ctrl-shift-t' },
    { action: 'page-up', chord: 'ctrl+alt+k' },
  ]
  const parsed = parseKeybindingOverrides(raw)
  assert.deepEqual(parsed.overrides, raw)
  assert.deepEqual(parsed.errors, [])
})

test('parse rejects non-array input with one descriptive error', () =>
{
  const parsed = parseKeybindingOverrides({ action: 'x', chord: 'y' })
  assert.deepEqual(parsed.overrides, [])
  assert.deepEqual(parsed.errors, [
    'keybinding overrides must be an array, got object',
  ])
  assert.equal(
    parseKeybindingOverrides('nope').errors[0],
    'keybinding overrides must be an array, got string'
  )
})

test('parse flags non-object entries with their position', () =>
{
  const parsed = parseKeybindingOverrides([
    'str',
    42,
    null,
    [],
    { action: 'ok', chord: 'ctrl+t' },
  ])
  assert.deepEqual(
    parsed.errors.map((error) => error.match(/#\d+/)?.[0]),
    ['#1', '#2', '#3', '#4']
  )
  assert.deepEqual(parsed.overrides, [{ action: 'ok', chord: 'ctrl+t' }])
})

test('parse flags missing or mistyped fields per field', () =>
{
  const parsed = parseKeybindingOverrides([
    { chord: 'ctrl+t' },
    { action: 'page-up' },
    { action: 7, chord: 'x' },
    { action: 'ok', chord: 'ctrl+t' },
  ])
  assert.deepEqual(parsed.errors, [
    'override #1 needs a string "action"',
    'override #2 needs a string "chord"',
    'override #3 needs a string "action"',
  ])
  assert.deepEqual(parsed.overrides, [{ action: 'ok', chord: 'ctrl+t' }])
})

test('parse caps collected errors at 10 entries', () =>
{
  const raw = Array.from({ length: 15 }, (_, i) => ({ action: i }))
  const parsed = parseKeybindingOverrides(raw)
  assert.equal(parsed.errors.length, 10)
})

test('normalize folds case across both separators', () =>
{
  assert.equal(normalizeChord('ctrl+T'), 'ctrl+t')
  assert.equal(normalizeChord('CTRL-t'), 'ctrl+t')
  assert.equal(normalizeChord('Shift-Ctrl-T'), 'ctrl+shift+t')
})

test('normalize maps alt to meta everywhere', () =>
{
  assert.equal(normalizeChord('alt+k'), 'meta+k')
  assert.equal(normalizeChord('ctrl-alt-k'), 'ctrl+meta+k')
  assert.equal(normalizeChord('shift-alt-x'), 'meta+shift+x')
})

test('normalize emits modifiers in fixed ctrl, meta, shift order', () =>
{
  assert.equal(normalizeChord('shift+ctrl+t'), 'ctrl+shift+t')
  assert.equal(normalizeChord('meta+ctrl+k'), 'ctrl+meta+k')
  assert.equal(normalizeChord('meta-shift-x'), 'meta+shift+x')
})

test('normalize accepts named keys and bare punctuation finals', () =>
{
  assert.equal(normalizeChord('pageup'), 'pageup')
  assert.equal(normalizeChord('F6'), 'f6')
  assert.equal(normalizeChord('ctrl+space'), 'ctrl+space')
  assert.equal(normalizeChord('?'), '?')
  assert.equal(normalizeChord('ctrl+/'), 'ctrl+/')
})

test('normalize rejects empty, modifier-only, & unknown finals', () =>
{
  assert.equal(normalizeChord(''), null)
  assert.equal(normalizeChord('   '), null)
  assert.equal(normalizeChord('ctrl'), null)
  assert.equal(normalizeChord('ctrl-shift'), null)
  assert.equal(normalizeChord('ctrl+alt'), null)
  assert.equal(normalizeChord('ab'), null)
  assert.equal(normalizeChord('ctrl+f13'), null)
  assert.equal(normalizeChord('ctrl+clear'), null)
})

test('literal + is a valid final via trailing separator handling', () =>
{
  assert.equal(normalizeChord('ctrl++'), 'ctrl++')
  assert.equal(normalizeChord('ctrl-+'), 'ctrl++')
  assert.equal(normalizeChord('+'), '+')
  // three separators in a row are ambiguous garbage
  assert.equal(normalizeChord('ctrl+++'), null)
})

test('lookup maps canonical chords to actions and skips invalid chords', () =>
{
  const { lookup, conflicts } = buildChordLookup([
    { action: 'toggle-thinking', chord: 'CTRL-T' },
    { action: 'page-down', chord: 'alt+d' },
    { action: 'ignored', chord: 'not-a-key' },
  ])
  assert.deepEqual(
    [...lookup.entries()],
    [
      ['ctrl+t', 'toggle-thinking'],
      ['meta+d', 'page-down'],
    ]
  )
  assert.deepEqual(conflicts, [])
})

test('later duplicate bindings win and differing ones conflict', () =>
{
  const { lookup, conflicts } = buildChordLookup([
    { action: 'page-up', chord: 'ctrl+u' },
    { action: 'jump-top', chord: 'ctrl-u' },
  ])
  assert.deepEqual([...lookup.entries()], [['ctrl+u', 'jump-top']])
  assert.deepEqual(conflicts, ['ctrl+u bound to both page-up and jump-top'])
})

test('re-binding a chord to its current action is not a conflict', () =>
{
  const { lookup, conflicts } = buildChordLookup([
    { action: 'page-up', chord: 'ctrl+u' },
    { action: 'page-up', chord: 'CTRL-U' },
  ])
  assert.deepEqual([...lookup.entries()], [['ctrl+u', 'page-up']])
  assert.deepEqual(conflicts, [])
})
