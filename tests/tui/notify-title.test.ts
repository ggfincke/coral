// tests/tui/notify-title.test.ts
// escape-byte and format assertions for shell notify and title helpers

import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  buildBell,
  buildDesktopNotification,
  sanitizeOscPayload,
  shouldNotifyFocusAware,
} from '../../src/tui/shell/notify.js'
import {
  BRAILLE_FRAMES,
  buildTerminalTitle,
  formatBlockedTitle,
  formatIdleTitle,
  formatRunningTitle,
} from '../../src/tui/shell/title.js'

describe('notify builders', () =>
{
  test('buildBell emits the bare BEL byte', () =>
  {
    assert.equal(buildBell(), '\u0007')
  })

  test('buildDesktopNotification frames title and body in OSC 9', () =>
  {
    assert.equal(
      buildDesktopNotification('turn done', '3 files changed'),
      '\u001b]9;turn done;3 files changed\u0007'
    )
  })

  test('buildDesktopNotification omits empty body and returns "" when both are empty', () =>
  {
    assert.equal(buildDesktopNotification('done'), '\u001b]9;done\u0007')
    assert.equal(
      buildDesktopNotification('done', '   \n\t '),
      '\u001b]9;done\u0007'
    )
    assert.equal(buildDesktopNotification('', ''), '')
  })

  test('sanitizeOscPayload strips ESC, BEL, other C0 controls, and bidi overrides', () =>
  {
    assert.equal(sanitizeOscPayload('a\u001bb\u0007c'), 'abc')
    assert.equal(sanitizeOscPayload('a\u0001\u001fb'), 'ab')
    assert.equal(
      sanitizeOscPayload('ok\u202ereversed\u202adone'),
      'okreverseddone'
    )
  })

  test('sanitizeOscPayload collapses whitespace runs, trims, and caps at 200 chars', () =>
  {
    assert.equal(sanitizeOscPayload('  a \t\n b   c '), 'a b c')
    assert.equal(sanitizeOscPayload('x'.repeat(250)).length, 200)
  })

  test('shouldNotifyFocusAware fires only when enabled and not definitely focused', () =>
  {
    assert.equal(shouldNotifyFocusAware(true, true), false)
    assert.equal(shouldNotifyFocusAware(false, true), true)
    assert.equal(shouldNotifyFocusAware(null, true), true)
    assert.equal(shouldNotifyFocusAware(false, false), false)
    assert.equal(shouldNotifyFocusAware(true, false), false)
  })
})

describe('title builders', () =>
{
  test('BRAILLE_FRAMES holds the 10 standard spinner frames in order', () =>
  {
    assert.deepEqual(BRAILLE_FRAMES, [
      '⠋',
      '⠙',
      '⠹',
      '⠸',
      '⠼',
      '⠴',
      '⠦',
      '⠧',
      '⠇',
      '⠏',
    ])
  })

  test('formatRunningTitle renders frame plus cwd basename', () =>
  {
    assert.equal(formatRunningTitle(0, '/tmp/project'), '⠋ coral · project')
    assert.equal(formatRunningTitle(9, '/tmp/project'), '⠏ coral · project')
  })

  test('formatRunningTitle cycles modulo array bounds', () =>
  {
    assert.equal(formatRunningTitle(10, '/w'), formatRunningTitle(0, '/w'))
    assert.equal(formatRunningTitle(23, '/w'), formatRunningTitle(3, '/w'))
    assert.equal(formatRunningTitle(-1, '/w'), formatRunningTitle(9, '/w'))
  })

  test('buildTerminalTitle emits exact OSC 0 bytes', () =>
  {
    assert.equal(
      buildTerminalTitle('coral · project'),
      '\u001b]0;coral · project\u0007'
    )
  })

  test('buildTerminalTitle reuses sanitization and caps content at 120 chars', () =>
  {
    const long = 'y'.repeat(300)
    assert.equal(buildTerminalTitle(long), `\u001b]0;${'y'.repeat(120)}\u0007`)
    assert.equal(buildTerminalTitle('a\u001bb\n c'), '\u001b]0;ab c\u0007')
  })

  test('blocked and idle titles use cwd basename', () =>
  {
    assert.equal(
      formatBlockedTitle('/tmp/project'),
      '[!] action required · project'
    )
    assert.equal(formatIdleTitle('/tmp/project'), 'coral · project')
  })
})
