// tests/tui/diff.test.ts
// renderer coverage: role tints, word pairing, side-by-side budget, truncation

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { renderUnifiedDiff } from '../../src/tui/transcript/diff.js'
import { visibleWidth, wrapLines } from '../../src/tui/wrap.js'
import { computeDiff } from '../../src/utils/diff.js'

// force truecolor so coral-reef role styles emit deterministic ANSI here
chalk.level = 3

const ADD_BG = '\x1b[48;2;29;42;32m'
const REMOVE_BG = '\x1b[48;2;47;31;34m'
const GUTTER_BG = '\x1b[48;2;35;38;44m'
const SUCCESS_FG = '\x1b[38;2;95;200;120m'
const ERROR_FG = '\x1b[38;2;235;90;80m'
const BOLD = '\x1b[1m'

const SAMPLE = [
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,4 +1,5 @@',
  ' context line',
  '-removed alpha',
  '+added beta',
  ' second ctx',
  '+tail add',
].join('\n')

const findRow = (lines: string[], needle: string): string =>
{
  const row = lines.find((l) => stripAnsi(l).includes(needle))
  assert.ok(row, `expected a row containing ${needle}`)
  return row
}

test('added/removed rows get foreground + background tints and gutters', () =>
{
  const lines = renderUnifiedDiff(SAMPLE, 80)

  const addRow = findRow(lines, '+added beta')
  assert.ok(addRow.includes(ADD_BG))
  assert.ok(addRow.includes(SUCCESS_FG))

  const delRow = findRow(lines, '-removed alpha')
  assert.ok(delRow.includes(REMOVE_BG))
  assert.ok(delRow.includes(ERROR_FG))

  // every content row carries the gutter tint on its line-number column
  const contentRows = lines.filter((l) => /^\s*\d/.test(stripAnsi(l)))
  assert.ok(contentRows.length >= 5)
  for (const row of contentRows)
  {
    assert.ok(row.includes(GUTTER_BG))
  }
})

test('paired -/+ rows get word-level emphasis, unpaired ones stay plain', () =>
{
  const paired = renderUnifiedDiff(
    [
      '--- x',
      '+++ y',
      '@@ -1,2 +1,2 @@',
      '-keep this OLD',
      '+keep this NEW',
    ].join('\n'),
    100
  )
  const split = renderUnifiedDiff(
    [
      '--- x',
      '+++ y',
      '@@ -1,3 +1,3 @@',
      '-keep this OLD',
      ' ctx gap',
      '+keep this NEW',
    ].join('\n'),
    100
  )

  const pDel = findRow(paired, 'OLD')
  const pAdd = findRow(paired, 'NEW')
  assert.ok(pDel.includes(BOLD), 'paired removal lacks word emphasis')
  assert.ok(pAdd.includes(BOLD), 'paired addition lacks word emphasis')
  assert.ok(stripAnsi(pDel).includes('keep this'))

  // adjacency is what enables pairing: separated rows render without emphasis
  const sDel = findRow(split, 'OLD')
  const sAdd = findRow(split, 'NEW')
  assert.ok(!sDel.includes(BOLD))
  assert.ok(!sAdd.includes(BOLD))

  // same logical lines, different ANSI between plain and paired renders
  assert.notEqual(pDel, sDel)
  assert.notEqual(pAdd, sAdd)
})

test('width > 120 switches to side-by-side panes within the width budget', () =>
{
  const diff = [
    '--- x',
    '+++ y',
    '@@ -1,2 +1,2 @@',
    '-left pane keeps OLD here',
    '+right pane shows NEW here',
  ].join('\n')

  const wide = renderUnifiedDiff(diff, 140)
  for (const line of wide)
  {
    assert.ok(
      visibleWidth(line) <= 140,
      `row exceeds budget: ${stripAnsi(line)}`
    )
  }
  // paired old/new share one physical row in side-by-side mode
  const shared = wide.find((l) =>
  {
    const s = stripAnsi(l)
    return s.includes('OLD') && s.includes('NEW')
  })
  assert.ok(shared, 'paired rows should share one side-by-side row')

  // below the threshold the two edits remain on separate rows
  const narrow = renderUnifiedDiff(diff, 60)
  for (const line of narrow)
  {
    assert.ok(visibleWidth(line) <= 60)
  }
  const narrowShared = narrow.find((l) =>
  {
    const s = stripAnsi(l)
    return s.includes('OLD') && s.includes('NEW')
  })
  assert.ok(!narrowShared, 'unified mode must not merge paired rows')
})

test('side-by-side panes wrap independently and continuations keep tints', () =>
{
  const longOld = 'start of the removed line '.repeat(4) + 'OLDTAIL'
  const longNew = 'beginning of the added line '.repeat(4) + 'NEWTAIL'
  const wide = renderUnifiedDiff(
    ['--- x', '+++ y', '@@ -1,2 +1,2 @@', `-${longOld}`, `+${longNew}`].join(
      '\n'
    ),
    140
  )

  for (const line of wide)
  {
    assert.ok(visibleWidth(line) <= 140)
  }
  const rows = wide.map((l) => stripAnsi(l))
  const oldCont = rows.findIndex((r) => r.includes('OLDTAIL'))
  const newCont = rows.findIndex((r) => r.includes('NEWTAIL'))
  assert.ok(oldCont > 0, 'old cell should wrap onto a continuation row')
  assert.ok(newCont > 0, 'new cell should wrap onto a continuation row')
  assert.ok(rows.some((r) => r.includes('start of the removed line')))
  assert.ok(rows.some((r) => r.includes('beginning of the added line')))
  assert.ok(wide[oldCont]!.includes(REMOVE_BG))
  assert.ok(wide[newCont]!.includes(ADD_BG))
})

test('wide CJK rows are sliced by visible width, not string length', () =>
{
  const lines = renderUnifiedDiff(
    [
      '--- c',
      '+++ c',
      '@@ -1,2 +1,2 @@',
      '-日本語のテキストは全角幅を持つので注意',
      '+漢字コード幅テスト',
    ].join('\n'),
    30
  )

  for (const line of lines)
  {
    assert.ok(
      visibleWidth(line) <= 30,
      `CJK row mis-sliced: ${stripAnsi(line)}`
    )
  }
  assert.ok(stripAnsi(lines.join('\n')).includes('日本語'))
})

test('over-long unified rows truncate w/ an ellipsis inside the width', () =>
{
  const lines = renderUnifiedDiff(
    [
      '--- a',
      '+++ b',
      '@@ -1,2 +1,2 @@',
      ' ' + 'x'.repeat(200),
      '+' + 'y'.repeat(200),
    ].join('\n'),
    40
  )

  const cutRow = findRow(lines, '…')
  assert.ok(stripAnsi(cutRow).includes('…'))
  for (const line of lines)
  {
    assert.ok(visibleWidth(line) <= 40)
  }
})

test('computeDiff keeps its 200-line cap and summary marker', () =>
{
  const before = Array.from({ length: 260 }, (_, i) => `line ${i}`).join('\n')
  const after = Array.from({ length: 260 }, (_, i) => `line ${i} changed`).join(
    '\n'
  )

  const diff = computeDiff(before, after)
  assert.ok(diff)
  const lines = diff!.split('\n')
  assert.equal(lines.length, 201)
  assert.match(lines[200]!, /^… \+\d+ more changed lines$/)
})

test('wrapLines keeps indent handling stable', () =>
{
  const lines = wrapLines('alpha beta gamma delta epsilon', 20, '  ')
  assert.ok(lines.length > 1)
  for (const line of lines)
  {
    assert.ok(line.startsWith('  '))
    assert.ok(visibleWidth(line) <= 20)
  }
})
