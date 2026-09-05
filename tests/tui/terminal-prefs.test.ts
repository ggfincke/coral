// tests/tui/terminal-prefs.test.ts
// env-driven color, motion, and kitty-keyboard preference gates

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  kittyKeyboardOptIn,
  noColorRequested,
  prefersReducedMotion,
} from '../../src/tui/shell/terminal-prefs.js'

test('noColorRequested honors NO_COLOR and FORCE_COLOR=0', () =>
{
  assert.equal(noColorRequested({ NO_COLOR: '1' }), true)
  assert.equal(noColorRequested({ NO_COLOR: '' }), false)
  assert.equal(noColorRequested({ FORCE_COLOR: '0' }), true)
  assert.equal(noColorRequested({ FORCE_COLOR: '1' }), false)
  assert.equal(noColorRequested({ NO_COLOR: '', FORCE_COLOR: '0' }), true)
  assert.equal(noColorRequested({}), false)
})

test('prefersReducedMotion honors CORAL_REDUCED_MOTION and dumb TERM', () =>
{
  assert.equal(prefersReducedMotion({ CORAL_REDUCED_MOTION: '1' }), true)
  assert.equal(prefersReducedMotion({ CORAL_REDUCED_MOTION: 'true' }), true)
  assert.equal(prefersReducedMotion({ CORAL_REDUCED_MOTION: 'yes' }), true)
  assert.equal(prefersReducedMotion({ CORAL_REDUCED_MOTION: 'YES' }), true)
  assert.equal(prefersReducedMotion({ CORAL_REDUCED_MOTION: '0' }), false)
  assert.equal(prefersReducedMotion({ CORAL_REDUCED_MOTION: '' }), false)
  assert.equal(prefersReducedMotion({ TERM: 'dumb' }), true)
  assert.equal(prefersReducedMotion({ TERM: 'xterm-256color' }), false)
  assert.equal(prefersReducedMotion({}), false)
})

test('kittyKeyboardOptIn requires the exact opt-in value', () =>
{
  assert.equal(kittyKeyboardOptIn({ CORAL_KITTY_KEYBOARD: '1' }), true)
  assert.equal(kittyKeyboardOptIn({ CORAL_KITTY_KEYBOARD: 'true' }), false)
  assert.equal(kittyKeyboardOptIn({ CORAL_KITTY_KEYBOARD: '' }), false)
  assert.equal(kittyKeyboardOptIn({}), false)
})
