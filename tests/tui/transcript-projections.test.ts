// tests/tui/transcript-projections.test.ts
// restore, export, copy, & panel projections of stored conversation text

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { lexer } from 'marked'
import { buildCompactedMessages } from '../../src/agent/state/compaction.js'
import { failedToolResultText } from '../../src/tui/run/use-agent-turn.js'
import { lastAssistantText, lastCodeBlock } from '../../src/tui/shell/copy.js'
import { buildSessionMarkdown } from '../../src/tui/shell/export-markdown.js'
import { formatBlockPlain } from '../../src/tui/transcript/plain.js'
import { buildRestoredBlocks } from '../../src/tui/transcript/restored-blocks.js'
import { buildTodoPanel } from '../../src/tui/transcript/todo-panel.js'
import type { OllamaMessage } from '../../src/types/inference.js'
import type { UndoTurn } from '../../src/types/undo.js'

const NUDGE = 'Your last turn was empty. Call a tool to make progress.'

// one typed prompt whose turn also holds an internal corrective prompt
const TURN_MESSAGES: OllamaMessage[] = [
  { role: 'system', content: 'System' },
  {
    role: 'user',
    content: '<attachment path="big.ts">BODY</attachment>\nsummarize',
    displayContent: '@big.ts summarize',
  },
  { role: 'assistant', content: '' },
  { role: 'user', content: NUDGE },
  { role: 'assistant', content: 'summary done' },
]

const TURN_UNDO: UndoTurn[] = [
  {
    startIndex: 1,
    endIndex: 5,
    userMessage: TURN_MESSAGES[1]!.content,
    messages: TURN_MESSAGES.slice(1),
    changes: [],
  },
]

test('restored blocks hide internal prompts and show the handoff as a notice', () =>
{
  const messages = [
    ...buildCompactedMessages([TURN_MESSAGES[0]!], 'SUMMARY BODY', []),
    ...TURN_MESSAGES.slice(1),
  ]
  const undo = TURN_UNDO.map((turn) => ({
    ...turn,
    startIndex: turn.startIndex + 1,
    endIndex: turn.endIndex + 1,
  }))

  const blocks = buildRestoredBlocks(messages, undo)

  assert.deepEqual(
    blocks.filter((block) => block.type === 'user'),
    [{ type: 'user', content: '@big.ts summarize' }]
  )
  assert.equal(blocks[0]?.type, 'system')
  assert.ok(
    !blocks.some(
      (block) => 'content' in block && block.content.includes('SUMMARY BODY')
    )
  )
})

test('restored blocks recover error status from the stored tool text', () =>
{
  const blocks = buildRestoredBlocks([
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: 'bash', arguments: { command: 'npm test' } } },
        { function: { name: 'read_file', arguments: { path: 'a.ts' } } },
      ],
    },
    { role: 'tool', tool_name: 'bash', content: 'Error: x\nstdout' },
    { role: 'tool', tool_name: 'read_file', content: 'file text' },
  ])

  assert.deepEqual(
    blocks.map((block) =>
      block.type === 'tool_call'
        ? block.status
        : block.type === 'tool_result'
          ? Boolean(block.isError)
          : block.type
    ),
    ['error', 'recorded', true, false]
  )
})

test('export shows typed prompts only and closes a dangling fence', () =>
{
  const md = buildSessionMarkdown({
    model: 'm',
    messages: [
      ...TURN_MESSAGES,
      { role: 'assistant', content: '```ts\nconst x =' },
      { role: 'user', content: 'next' },
    ],
    undo: TURN_UNDO,
  })

  assert.ok(md.includes('@big.ts summarize'))
  assert.ok(!md.includes('BODY'))
  assert.ok(!md.includes(NUDGE))
  const headings = lexer(md)
    .filter((token) => token.type === 'heading')
    .map((token) => token.raw.trim())
  assert.deepEqual(headings, [
    '# Coral session',
    '## User',
    '## Assistant',
    '## Assistant',
    '## Assistant',
    '## User',
  ])
})

test('export leaves fences that a quote, list, or indent already closed', () =>
{
  const bodies = [
    '> ```js\n> x\n\nafter quote',
    '- item\n  ```js\n  x\n\nafter list',
    'para\n\n    ```\n    not a fence\n\ndone',
  ]
  for (const body of bodies)
  {
    const md = buildSessionMarkdown({
      model: 'm',
      messages: [
        { role: 'assistant', content: body },
        { role: 'user', content: 'next' },
      ],
    })
    const headings = lexer(md)
      .filter((token) => token.type === 'heading')
      .map((token) => token.raw.trim())
    assert.deepEqual(
      headings,
      ['# Coral session', '## Assistant', '## User'],
      body
    )
  }
})

test('a failed live tool result keeps the output the model saw', () =>
{
  const text = failedToolResultText('Command failed: tsc', 'src/a.ts: TS2322')
  assert.equal(text, 'Command failed: tsc\nsrc/a.ts: TS2322')
  assert.equal(failedToolResultText('boom', ''), 'boom')
})

test('plain lines prefix every line of a multi-line prompt', () =>
{
  assert.deepEqual(formatBlockPlain({ type: 'user', content: 'a\nb' }), [
    '> a',
    '> b',
  ])
  assert.deepEqual(formatBlockPlain({ type: 'system', content: 'a\nb' }), [
    'a',
    'b',
  ])
})

test('todo panel rows drop terminal controls and newlines', () =>
{
  const rows = buildTodoPanel(
    [
      { content: 'a\u001b]8;;x://y\u0007b\nc', status: 'pending' },
      { content: 'naïve 漢字 ✓', status: 'pending' },
    ],
    40
  )
  for (const row of rows)
  {
    for (const control of ['\u001b', '\u0007', '\n'])
    {
      assert.ok(!row.includes(control), JSON.stringify(row))
    }
  }
  assert.ok(rows.some((row) => row.includes('naïve 漢字 ✓')))
})

test('/copy text matches the display: hidden controls dropped, tabs kept', () =>
{
  const hostile = lastAssistantText([
    {
      role: 'assistant',
      content: '```sh\nmake test\u001b]\nrm x\n\u0007\n```',
    },
  ])
  assert.equal(lastCodeBlock(hostile!), 'make test')

  const code = '```py\ndef f():\n\treturn 1\n```'
  assert.equal(
    lastCodeBlock(lastAssistantText([{ role: 'assistant', content: code }])!),
    'def f():\n\treturn 1'
  )
})
