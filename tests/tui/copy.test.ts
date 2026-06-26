// tests/tui/copy.test.ts
// tests for the /copy extraction helpers

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { lastAssistantText, lastCodeBlock } from '../../src/tui/shell/copy.js'
import type { OllamaMessage } from '../../src/types/inference.js'

test('lastAssistantText returns the most recent non-empty assistant reply', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'more' },
    { role: 'assistant', content: 'second answer' },
  ]

  assert.equal(lastAssistantText(messages), 'second answer')
})

test('lastAssistantText skips tool-call-only assistant turns', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'assistant', content: 'the real answer' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'read_file', arguments: {} } }],
    },
    { role: 'tool', content: 'tool output', tool_name: 'read_file' },
  ]

  assert.equal(lastAssistantText(messages), 'the real answer')
})

test('lastAssistantText returns null when there is no assistant text', () =>
{
  assert.equal(lastAssistantText([{ role: 'user', content: 'hi' }]), null)
})

test('lastCodeBlock extracts the final fenced block', () =>
{
  const md = 'intro\n\n```js\nconst a = 1\n```\n\nthen\n\n```py\nx = 2\n```\n'

  assert.equal(lastCodeBlock(md), 'x = 2')
})

test('lastCodeBlock ignores inline code spans', () =>
{
  assert.equal(lastCodeBlock('just prose with `inline` only'), null)
})

test('lastCodeBlock returns null when there are no code blocks', () =>
{
  assert.equal(lastCodeBlock('plain paragraph text'), null)
})
