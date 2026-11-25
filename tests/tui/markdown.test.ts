// tests/tui/markdown.test.ts
// markdown renderer: tight lists, decoded control references, untagged fence cost

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import chalk from 'chalk'
import highlighter from 'cli-highlight'
import stripAnsi from 'strip-ansi'
import { highlightCode } from '../../src/tui/transcript/code-highlight.js'
import { renderMarkdownToAnsi } from '../../src/tui/transcript/markdown.js'
import { codeSpanStyle } from '../../src/tui/theme.js'

// force color so styled output carries deterministic SGR codes here
chalk.level = 3

test('tight lists render inline styling w/o raw markers or blank rows', () =>
{
  const cases: Array<[string, string]> = [
    [
      '- **bold** item `code`\n- [link](http://x)\n',
      '• bold item  code \n• link (http://x)',
    ],
    ['- [ ] todo **x**\n- [x] done\n', '[ ] todo x\n[x] done'],
    ['1. first **one**\n2. second\n', '1. first one\n2. second'],
    ['- **bold** item\n\n- loose second\n', '• bold item\n\n• loose second'],
  ]
  for (const [markdown, expected] of cases)
  {
    assert.equal(stripAnsi(renderMarkdownToAnsi(markdown)), expected)
  }
})

test('numeric character references cannot decode into terminal controls', () =>
{
  const osc = renderMarkdownToAnsi('x &#27;]8;;http://a&#7;y&#27;]8;;&#7;')
  assert.ok(!osc.includes('\x1b]'))
  assert.ok(!osc.includes('\x07'))
  const csi = renderMarkdownToAnsi('- a &#x9b;2J b\n- &#27;[8mhidden')
  assert.ok(!csi.includes('\x9b'))
  assert.ok(!csi.includes('\x1b[8m'))

  // styling coral adds itself still reaches the terminal
  const styled = renderMarkdownToAnsi('**bold** and `span`')
  assert.ok(styled.includes('\x1b[1m'))
  assert.ok(styled.includes(codeSpanStyle()(' span ')))
})

test('large untagged fences skip auto-detect while tagged & small ones highlight', (t) =>
{
  const highlight = t.mock.method(highlighter, 'highlight')
  const started = performance.now()
  const big = renderMarkdownToAnsi(`\`\`\`\n${'a '.repeat(10_000)}\n\`\`\`\n`)
  assert.ok(performance.now() - started < 250)
  assert.ok(stripAnsi(big).includes('a a a'))
  assert.equal(highlight.mock.callCount(), 0)

  const snippet = Array.from(
    { length: 20 },
    (_, i) => `const markdownTest${i} = compute(${i})`
  ).join('\n')
  highlightCode(snippet)
  highlightCode('const markdownTagged: number = 1', 'ts')
  assert.equal(highlight.mock.callCount(), 2)
  assert.equal(highlight.mock.calls[0]!.arguments[1]?.language, undefined)
  assert.equal(highlight.mock.calls[1]!.arguments[1]?.language, 'ts')
})
