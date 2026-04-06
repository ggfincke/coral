// tests/tui.test.ts
// regression tests for Tier 2 TUI helpers

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import stripAnsi from 'strip-ansi'
import { renderMarkdownToAnsi } from '../src/tui/markdown.js'
import { buildModelPickerLines, sortModels } from '../src/tui/model-picker.js'
import {
  buildTranscriptLines,
  maxScrollOffset,
  sliceViewport,
  type OutputBlock,
} from '../src/tui/transcript.js'

test('renderMarkdownToAnsi formats headings, links, lists, & code blocks', () =>
{
  const rendered = stripAnsi(
    renderMarkdownToAnsi(`
# Build Plan

Read the **README** before touching [src/agent/agent.ts](src/agent/agent.ts).

- inspect the prompt
- verify the tools

\`\`\`ts
const value = 1;
\`\`\`
`)
  )

  assert.match(rendered, /Build Plan/)
  assert.match(rendered, /README/)
  assert.match(rendered, /src\/agent\/agent\.ts/)
  assert.match(rendered, /• inspect the prompt/)
  assert.match(rendered, /• verify the tools/)
  assert.match(rendered, /const value = 1;/)
})

test('buildTranscriptLines renders speaker labels & viewport slicing', () =>
{
  const blocks: OutputBlock[] = [
    { type: 'user', content: 'inspect src/agent/agent.ts' },
    { type: 'thinking', content: 'Inspect the prompt & tool flow first.' },
    {
      type: 'assistant',
      content:
        '## Findings\n\n- approval flow exists\n- markdown is missing\n- model picker is missing',
    },
    {
      type: 'tool_call',
      toolName: 'read_file',
      args: { path: 'src/agent/agent.ts' },
      status: 'success',
      duration: 200,
    },
    {
      type: 'tool_result',
      toolName: 'read_file',
      content: 'file contents here',
    },
  ]

  const lines = buildTranscriptLines({ blocks, streaming: '', width: 60 }).map(
    (line) => stripAnsi(line)
  )

  // check new prefix characters & labels
  assert.ok(
    lines.some((line) => line.includes('›')),
    'user prefix › missing'
  )
  assert.ok(
    lines.some((line) => line.includes('Thinking')),
    'thinking label missing'
  )
  assert.ok(
    lines.some((line) =>
      line.includes('Inspect the prompt & tool flow first.')
    ),
    'thinking content missing'
  )
  assert.ok(
    lines.some((line) => line.includes('Coral')),
    'assistant label missing'
  )
  assert.ok(
    lines.some((line) => line.includes('⎿')),
    'tool call connector ⎿ missing'
  )
  assert.ok(
    lines.some((line) => line.includes('✓')),
    'success indicator ✓ missing'
  )
  assert.ok(
    lines.some((line) => line.includes('└')),
    'tool result tree connector └ missing'
  )
  assert.ok(lines.some((line) => line.includes('approval flow exists')))

  const viewportHeight = 5
  const offset = maxScrollOffset(lines.length, viewportHeight)
  const liveViewport = sliceViewport(lines, viewportHeight, 0)
  const topViewport = sliceViewport(lines, viewportHeight, offset)

  assert.equal(liveViewport.length, viewportHeight)
  assert.equal(topViewport.length, viewportHeight)
  assert.equal(topViewport[0], lines[0])
  assert.equal(liveViewport.at(-1), lines.at(-1))
})

test('buildTranscriptLines can hide reasoning while preserving a live hint', () =>
{
  const blocks: OutputBlock[] = [
    { type: 'thinking', content: 'Read the repo before answering.' },
    { type: 'assistant', content: 'Ready.' },
  ]

  const hiddenLines = buildTranscriptLines({
    blocks,
    streaming: '',
    width: 60,
    showThinking: false,
  }).map((line) => stripAnsi(line))
  const liveHiddenLines = buildTranscriptLines({
    blocks: [],
    streaming: '',
    width: 60,
    streamingThinking: 'Inspecting files',
    showThinking: false,
  }).map((line) => stripAnsi(line))

  assert.ok(
    !hiddenLines.some((line) =>
      line.includes('Read the repo before answering.')
    )
  )
  assert.ok(hiddenLines.some((line) => line.includes('Ready.')))
  assert.ok(liveHiddenLines.some((line) => line.includes('Thinking hidden')))
  assert.ok(liveHiddenLines.some((line) => line.includes('ctrl+t to show')))
})

test('model picker sorts newest models first & renders selected metadata', () =>
{
  const models = sortModels([
    {
      name: 'qwen2.5-coder:7b',
      size: 8_000_000_000,
      modified_at: '2024-01-01T01:01:00.000Z',
    },
    {
      name: 'devstral-small:latest',
      size: 12_000_000_000,
      modified_at: '2025-02-02T02:02:00.000Z',
    },
  ])

  assert.deepEqual(
    models.map((model) => model.name),
    ['devstral-small:latest', 'qwen2.5-coder:7b']
  )

  const lines = buildModelPickerLines(models, 1, 48, 10).map((line) =>
    stripAnsi(line)
  )

  assert.ok(lines.includes('Select an Ollama model'))
  assert.ok(lines.some((line) => line.includes('› qwen2.5-coder:7b')))
  assert.ok(lines.some((line) => line.includes('Selected: qwen2.5-coder:7b')))
  assert.ok(
    lines.some((line) => line.includes('Modified: 2024-01-01T01:01:00.000Z'))
  )
})
