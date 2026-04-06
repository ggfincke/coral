// tests/prompt-input.test.ts
// regression tests for unified prompt input parsing

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  isParsedControlSequence,
  isParsedControlFragment,
  buildKey,
} from '../src/tui/use-coral-input.js'
import { isThinkingToggleShortcut } from '../src/tui/prompt-input.js'

test('isParsedControlSequence ignores mouse packets, focus events, & paste markers', () =>
{
  assert.equal(isParsedControlSequence('[<64;20;38M'), true)
  assert.equal(isParsedControlSequence('\x1b[<65;20;38M'), true)
  assert.equal(isParsedControlSequence('[<64;20;3'), true)
  assert.equal(isParsedControlSequence('\x1b[200~'), true)
  assert.equal(isParsedControlSequence('[I'), true)
  assert.equal(isParsedControlSequence('plain text'), false)
  assert.equal(isParsedControlSequence('[literal text'), false)
})

test('isParsedControlFragment keeps buffering only partial mouse packets', () =>
{
  assert.equal(isParsedControlFragment('[<64;20;3'), true)
  assert.equal(isParsedControlFragment('\x1b[<65;20;'), true)
  assert.equal(isParsedControlFragment('[<64;20;38M'), false)
  assert.equal(isParsedControlFragment('plain text'), false)
})

test('isThinkingToggleShortcut requires ctrl+t so plain typing still works', () =>
{
  assert.equal(isThinkingToggleShortcut('t', buildKey({ ctrl: true })), true)
  assert.equal(
    isThinkingToggleShortcut('T', buildKey({ ctrl: true, shift: true })),
    true
  )
  assert.equal(isThinkingToggleShortcut('t', buildKey()), false)
  assert.equal(isThinkingToggleShortcut('x', buildKey({ ctrl: true })), false)
})
