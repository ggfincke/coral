// tests/tui/prompt-render.test.ts
// tests for multi-line prompt rendering & the draft scroll window

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import chalk from 'chalk'
import {
  countPromptRenderRows,
  MAX_PROMPT_VIEW_ROWS,
  renderPromptValueWithCursor,
} from '../../src/tui/prompt/prompt-render.js'

test('single-line rendering keeps the caret & trailing block', () =>
{
  assert.equal(renderPromptValueWithCursor('', 0, 0), chalk.inverse(' '))
  assert.equal(
    renderPromptValueWithCursor('hi', 2, 0),
    'hi' + chalk.inverse(' ')
  )
  assert.equal(
    renderPromptValueWithCursor('hi', 0, 0),
    chalk.inverse('h') + 'i'
  )
})

test('multi-line drafts render one styled row per logical line', () =>
{
  const rendered = renderPromptValueWithCursor('ab\ncd\nef', 4, 0)

  assert.equal(rendered, `ab\n${chalk.inverse('c')}d\nef`)
})

test('a cursor sitting on a newline renders a caret at line end', () =>
{
  const rendered = renderPromptValueWithCursor('ab\ncd', 2, 0)
  const lines = rendered.split('\n')

  assert.equal(lines[0], 'ab' + chalk.inverse(' '))
  assert.equal(lines[1], 'cd')
})

test('countPromptRenderRows counts logical lines capped to the window', () =>
{
  assert.equal(countPromptRenderRows(''), 1)
  assert.equal(countPromptRenderRows('a\nb'), 2)
  assert.equal(
    countPromptRenderRows(Array.from({ length: 30 }, () => 'x').join('\n')),
    MAX_PROMPT_VIEW_ROWS
  )
})

test('long drafts scroll around the cursor & mark clipped rows', () =>
{
  const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`)
  const value = lines.join('\n')

  // cursor at the end: window shows the tail w/ a clip marker
  const rendered = renderPromptValueWithCursor(value, value.length, 0)
  const visible = rendered.split('\n')

  assert.equal(visible.length, MAX_PROMPT_VIEW_ROWS)
  assert.ok(visible[0]?.startsWith('…'))
  assert.ok(rendered.endsWith(chalk.inverse(' ')))

  // cursor back on the first line: no clip marker, window starts at the top
  const headRendered = renderPromptValueWithCursor(value, 3, 0)
  const headVisible = headRendered.split('\n')
  assert.ok(headVisible[0]?.startsWith('line-0'))
  assert.equal(headVisible[0]?.startsWith('…'), false)
})
