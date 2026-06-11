// tests/theme.test.ts
// tests for the role-based theme system

import { strict as assert } from 'node:assert'
import { afterEach, test } from 'node:test'
import chalk from 'chalk'
import {
  getTheme,
  getThemeGeneration,
  headingStyle,
  inkColor,
  roleRgb,
  setTheme,
  style,
  type Role,
} from '../src/tui/theme.js'
import {
  ADAPTIVE,
  CORAL_REEF,
  DEEP_SEA,
  DEFAULT_THEME,
  findTheme,
  THEMES,
} from '../src/tui/themes.js'
import {
  buildTranscriptLines,
  type OutputBlock,
} from '../src/tui/transcript.js'

// force truecolor so styled output is observable in non-tty test runs
chalk.level = 3

const ALL_ROLES: Role[] = [
  'primary',
  'accent',
  'user',
  'code',
  'muted',
  'success',
  'warning',
  'error',
  'thinking',
  'codeBg',
]

afterEach(() =>
{
  setTheme(DEFAULT_THEME)
})

test('default theme is coral reef', () =>
{
  assert.equal(getTheme(), CORAL_REEF)
  assert.equal(DEFAULT_THEME, CORAL_REEF)
})

test('setTheme swaps the active theme & bumps the generation', () =>
{
  const before = getThemeGeneration()
  setTheme(DEEP_SEA)
  assert.equal(getTheme(), DEEP_SEA)
  assert.equal(getThemeGeneration(), before + 1)
})

test('style resolves roles against the active theme at call time', () =>
{
  assert.ok(style('primary')('x').includes('38;2;255;127;80'))
  setTheme(DEEP_SEA)
  assert.ok(style('primary')('x').includes('38;2;122;231;255'))
})

test('style maps ansi roles to named terminal colors', () =>
{
  setTheme(ADAPTIVE)
  // chalk magenta fg is SGR 35
  assert.ok(style('primary')('x').includes('[35m'))
})

test('inkColor returns hex for rgb roles & names for ansi roles', () =>
{
  assert.equal(inkColor('primary'), '#ff7f50')
  assert.equal(inkColor('user'), '#00beb4')
  setTheme(ADAPTIVE)
  assert.equal(inkColor('primary'), 'magenta')
  assert.equal(inkColor('muted'), 'gray')
})

test('roleRgb returns rgb for truecolor themes & null for ansi roles', () =>
{
  assert.deepEqual(roleRgb('primary'), { r: 255, g: 127, b: 80 })
  setTheme(ADAPTIVE)
  assert.equal(roleRgb('primary'), null)
})

test('headingStyle themes h1-h4 & falls back past h4', () =>
{
  // h1 -> primary (coral) bold
  assert.ok(headingStyle(1)('t').includes('38;2;255;127;80'))
  // h5 has no themed role -> whiteBright (SGR 97) bold fallback
  assert.ok(headingStyle(5)('t').includes('[97m'))
})

test('findTheme matches id & label case-insensitively', () =>
{
  assert.equal(findTheme('deep-sea'), DEEP_SEA)
  assert.equal(findTheme('Deep Sea'), DEEP_SEA)
  assert.equal(findTheme('  CORAL-REEF '), CORAL_REEF)
  assert.equal(findTheme('nope'), undefined)
})

test('every theme defines every role & four heading levels', () =>
{
  for (const theme of THEMES)
  {
    for (const role of ALL_ROLES)
    {
      assert.ok(role in theme.roles, `${theme.name} missing role ${role}`)
    }
    assert.equal(theme.headings.length, 4)
  }
})

test('theme switch invalidates cached transcript lines', () =>
{
  // same block object twice -> exercises the WeakMap cache across a switch
  const blocks: OutputBlock[] = [{ type: 'user', content: 'hello' }]

  const before = buildTranscriptLines({ blocks, streaming: '', width: 80 })
  assert.ok(before.join('\n').includes('38;2;0;190;180'))

  setTheme(DEEP_SEA)
  const after = buildTranscriptLines({ blocks, streaming: '', width: 80 })
  assert.ok(after.join('\n').includes('38;2;63;224;208'))
})

test('theme names are unique kebab-case ids', () =>
{
  const names = THEMES.map((theme) => theme.name)
  assert.equal(new Set(names).size, names.length)
  for (const name of names)
  {
    assert.match(name, /^[a-z]+(-[a-z]+)*$/)
  }
})
