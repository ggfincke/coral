// tests/tui/paste.test.ts
// tests for bracketed-paste sanitizing, placeholder, & expansion logic

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  boundPastedText,
  buildPastePlaceholder,
  countPastedLines,
  expandPastePlaceholders,
  PASTE_STORE_LIMIT,
  PLACEHOLDER_MIN_CHARS,
  sanitizePastedText,
  shouldPlaceholderize,
} from '../../src/tui/prompt/paste.js'

test('sanitizePastedText strips escapes & controls but keeps content', () =>
{
  assert.equal(
    sanitizePastedText('\x1b[200~hello\r\nworld\x1b[201~'),
    'hello\nworld'
  )

  assert.equal(sanitizePastedText('\x1b[31mred\x1b[0m!'), 'red!')
  assert.equal(sanitizePastedText('\x1b]0;title\x07body'), 'body')
  assert.equal(sanitizePastedText('a\tb\x00c\x7fd'), 'a\tbcd')
  assert.equal(sanitizePastedText('中文\nテスト'), '中文\nテスト')
  assert.equal(sanitizePastedText('\r\nmixed\rline'), '\nmixed\nline')
})

test('shouldPlaceholderize follows the newline/size rules', () =>
{
  assert.equal(shouldPlaceholderize(''), false)
  assert.equal(shouldPlaceholderize('short line'), false)
  assert.equal(shouldPlaceholderize('x'.repeat(PLACEHOLDER_MIN_CHARS)), false)
  assert.equal(
    shouldPlaceholderize('x'.repeat(PLACEHOLDER_MIN_CHARS + 1)),
    true
  )
  assert.equal(shouldPlaceholderize('two\nlines'), true)
})

test('countPastedLines & buildPastePlaceholder format tokens', () =>
{
  assert.equal(countPastedLines('one'), 1)
  assert.equal(countPastedLines('a\nb'), 2)
  assert.equal(countPastedLines('a\n\nb'), 3)

  assert.equal(
    buildPastePlaceholder(3, 'a\nb\nc\nd'),
    '[Pasted text #3 +4 lines]'
  )
})

test('boundPastedText keeps text under the limit verbatim', () =>
{
  const text = 'x'.repeat(PASTE_STORE_LIMIT)
  assert.deepEqual(boundPastedText(text), { text, truncatedChars: 0 })
  assert.deepEqual(boundPastedText('short'), {
    text: 'short',
    truncatedChars: 0,
  })
})

test('boundPastedText truncates oversized pastes to head+marker+tail', () =>
{
  const head = 'H'.repeat(50_000)
  const tail = 'T'.repeat(50_000)
  const text = head + 'M'.repeat(5_000) + tail

  const bounded = boundPastedText(text)

  assert.equal(bounded.truncatedChars, 5_000)
  assert.ok(bounded.text.startsWith(head))
  assert.ok(bounded.text.endsWith(tail))
  assert.ok(
    bounded.text.includes('[Pasted text truncated: 5000 chars dropped]')
  )
  const marker = '\n[Pasted text truncated: 5000 chars dropped]\n'
  assert.equal(bounded.text.length, head.length + marker.length + tail.length)
})

test('expandPastePlaceholders splices stored texts at send time', () =>
{
  const registry = new Map<number, string>([
    [1, 'full\ntext one'],
    [2, 'second paste'],
  ])

  assert.equal(
    expandPastePlaceholders(
      'look [Pasted text #1 +2 lines] then [Pasted text #2 +1 lines]',
      (id) => registry.get(id)
    ),
    'look full\ntext one then second paste'
  )
})

test('expandPastePlaceholders leaves unknown or hand-typed tokens alone', () =>
{
  const registry = new Map<number, string>([[1, 'kept']])

  assert.equal(
    expandPastePlaceholders('[Pasted text #9 +3 lines]', (id) =>
      registry.get(id)
    ),
    '[Pasted text #9 +3 lines]'
  )
  assert.equal(
    expandPastePlaceholders('[Pasted text #1 +1 lines]', () => undefined),
    '[Pasted text #1 +1 lines]'
  )
  // w/ an empty registry a typed lookalike is plain prose, not a token
  assert.equal(
    expandPastePlaceholders(
      'wrote "[Pasted text #2 +2 lines]" myself',
      () => undefined
    ),
    'wrote "[Pasted text #2 +2 lines]" myself'
  )
})
