// tests/tui/wrap.test.ts
// coverage for ANSI-aware width helpers

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import stripAnsi from 'strip-ansi'
import chalk from 'chalk'
import { center, padEnd, visibleWidth } from '../../src/tui/wrap.js'

test('visibleWidth strips ANSI escapes', () =>
{
  const styled = chalk.red('hello')
  assert.equal(visibleWidth(styled), 5)
  assert.equal(visibleWidth('plain'), 5)
})

test('padEnd pads to visible width across ANSI spans', () =>
{
  const cell = chalk.red('hi')
  const padded = padEnd(cell, 5)
  assert.equal(visibleWidth(padded), 5)
})

test('center adds leading padding to center a styled line', () =>
{
  const line = chalk.bold('ab')
  const centered = center(line, 8)
  assert.equal(visibleWidth(centered), 8)
  assert.equal(stripAnsi(centered).trim(), 'ab')
})
