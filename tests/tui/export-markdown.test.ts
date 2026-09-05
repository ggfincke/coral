// tests/tui/export-markdown.test.ts
// tests for conversation -> markdown export serialization

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildSessionMarkdown } from '../../src/tui/shell/export-markdown.js'
import type { OllamaMessage } from '../../src/types/inference.js'

const MESSAGES: OllamaMessage[] = [
  {
    role: 'system',
    content: 'internal framing the export must skip',
  },
  { role: 'user', content: 'fix the bug' },
  {
    role: 'assistant',
    content: 'fixed in src/a.ts',
    thinking: 'step by step reasoning',
    tool_calls: [
      {
        function: { name: 'edit_file', arguments: { path: 'src/a.ts' } },
      },
    ],
  },
  {
    role: 'tool',
    tool_name: 'edit_file',
    content: 'applied 1 edit',
  },
]

test('default export emits metadata header & user/assistant sections', () =>
{
  const md = buildSessionMarkdown({
    title: 'Bug hunt',
    sessionId: 'abc123',
    model: 'gemma4:31b-mlx',
    cwd: '/repo',
    messages: MESSAGES,
  })

  assert.ok(md.startsWith('# Bug hunt\n'))
  assert.ok(md.includes('- model: gemma4:31b-mlx'))
  assert.ok(md.includes('- session: abc123'))
  assert.ok(md.includes('- cwd: /repo'))
  assert.ok(md.includes('## User\n\nfix the bug'))
  assert.ok(md.includes('## Assistant\n\nfixed in src/a.ts'))
  // system framing & tool detail stay out by default
  assert.equal(md.includes('internal framing'), false)
  assert.equal(md.includes('edit_file'), false)
})

test('tools & thinking flags include their sections', () =>
{
  const md = buildSessionMarkdown(
    { model: 'm', messages: MESSAGES },
    { includeTools: true, includeThinking: true }
  )

  assert.ok(md.includes('**tool call:** `edit_file`'))
  assert.ok(md.includes('### Tool result — edit_file'))
  assert.ok(md.includes('applied 1 edit'))
  assert.ok(md.includes('<details><summary>thinking</summary>'))
  assert.ok(md.includes('step by step reasoning'))
})

test('missing title falls back & trailing blank lines collapse', () =>
{
  const md = buildSessionMarkdown({
    model: 'm',
    messages: [{ role: 'user', content: 'one message' }],
  })

  assert.ok(md.startsWith('# Coral session\n'))
  // document ends with exactly one trailing newline
  assert.equal(md.endsWith('\n'), true)
  assert.equal(md.endsWith('\n\n\n'), false)
})
