// tests/tui/plain.test.ts
// tests for ANSI-free transcript block rendering

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  formatBlockPlain,
  formatBlocksPlain,
} from '../../src/tui/transcript/plain.js'
import type { OutputBlock } from '../../src/tui/transcript/types.js'

test('formatBlockPlain renders each block kind without escapes', () =>
{
  assert.deepEqual(formatBlockPlain({ type: 'user', content: 'hello' }), [
    '> hello',
  ])
  assert.deepEqual(
    formatBlockPlain({ type: 'assistant', content: 'line1\nline2' }),
    ['line1', 'line2']
  )
  assert.deepEqual(formatBlockPlain({ type: 'thinking', content: 'hmm' }), [
    '[thinking]',
    'hmm',
  ])
  assert.deepEqual(
    formatBlockPlain({
      type: 'tool_call',
      toolName: 'read_file',
      args: { path: 'a.ts' },
      status: 'success',
      duration: 12.4,
    }),
    ['[tool] read_file {"path":"a.ts"} (12ms)']
  )
  assert.deepEqual(
    formatBlockPlain({
      type: 'tool_result',
      toolName: 'bash',
      content: 'out1\nout2',
    }),
    ['[result] bash', '  out1', '  out2']
  )
  assert.deepEqual(
    formatBlockPlain({ type: 'diff', unified: '--- a\n+++ b\n@@ -1 +' }),
    ['--- a', '+++ b', '@@ -1 +']
  )
  assert.deepEqual(formatBlockPlain({ type: 'error', content: 'boom' }), [
    '[error]',
    'boom',
  ])
  assert.deepEqual(formatBlockPlain({ type: 'system', content: 'note' }), [
    'note',
  ])
})

test('oversized tool args truncate w/ an ellipsis marker', () =>
{
  const block = formatBlockPlain({
    type: 'tool_call',
    toolName: 'write_file',
    args: { content: 'x'.repeat(500) },
  })
  assert.equal(block.length, 1)
  assert.ok(block[0]!.endsWith('…'))
  assert.ok(block[0]!.length < 300)
})

test('formatBlocksPlain concatenates blocks in order', () =>
{
  const blocks: OutputBlock[] = [
    { type: 'system', content: 'welcome' },
    { type: 'user', content: 'hi' },
  ]
  assert.deepEqual(formatBlocksPlain(blocks), ['welcome', '> hi'])
})
