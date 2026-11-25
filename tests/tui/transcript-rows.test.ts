// tests/tui/transcript-rows.test.ts
// transcript row geometry for tabs & wide text, and linked path labels

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import stripAnsi from 'strip-ansi'
import { buildTranscriptLines } from '../../src/tui/transcript/transcript.js'
import type { OutputBlock } from '../../src/tui/transcript/types.js'
import { visibleWidth } from '../../src/tui/wrap.js'

function rowsFor(block: OutputBlock, width: number, cwd?: string): string[]
{
  return buildTranscriptLines({ blocks: [block], streaming: '', width, cwd })
}

test('tab-indented diff rows fit the width w/o spurious wrap rows', () =>
{
  const unified = [
    '@@ -1,3 +1,3 @@',
    ' func main() {',
    '-\tfmt.Println("old")',
    '+\tfmt.Println("new")',
    ' }',
  ].join('\n')
  const rows = rowsFor({ type: 'diff', unified }, 80)
  const content = rows.filter((row) => /│ +\d/.test(stripAnsi(row)))
  assert.equal(content.length, 4)
  assert.equal(rows.length, 5)
  for (const row of rows) assert.ok(visibleWidth(row) <= 80)
})

test('tool result continuation rows keep the gutter for tabs & wide text', () =>
{
  const content = `\t\t\t\t${'x'.repeat(60)}\n${'漢'.repeat(50)}\nnext line`
  const rows = rowsFor({ type: 'tool_result', toolName: 'bash', content }, 80)
  for (const row of rows)
  {
    assert.match(stripAnsi(row), /^ {3}│/)
    assert.ok(visibleWidth(row) <= 80)
  }
})

test('linked path labels keep `$` patterns literal', (t) =>
{
  process.env.CORAL_HYPERLINKS = '1'
  t.after(() =>
  {
    delete process.env.CORAL_HYPERLINKS
  })
  const rows = rowsFor(
    {
      type: 'tool_call',
      toolName: 'read_file',
      args: { path: 'src/a$&b.ts' },
      status: 'recorded',
    },
    120,
    '/tmp/ws'
  )
  const text = stripAnsi(rows.join('\n'))
  assert.equal(text.split('src/a$&b.ts').length - 1, 1)
  assert.ok(!text.includes('asrc'))
})
