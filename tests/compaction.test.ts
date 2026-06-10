// tests/compaction.test.ts
// tests for conversation compaction

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { OllamaMessage } from '../src/types/inference.js'
import {
  estimateTotalTokens,
  shouldCompact,
  shouldPrune,
  splitForCompaction,
  buildCompactionPrompt,
  buildCompactedMessages,
  buildPruneMarker,
  pruneToolResults,
  stripThinkingForCompaction,
  DEFAULT_COMPACTION_CONFIG,
  type CompactionConfig,
} from '../src/agent/compaction.js'

// helper to build a conversation w/ N user-assistant pairs
function buildConversation(turns: number): OllamaMessage[]
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
  ]

  for (let i = 0; i < turns; i++)
  {
    messages.push({
      role: 'user',
      content: `Question ${i + 1}: What about topic ${i + 1}?`,
    })
    messages.push({
      role: 'assistant',
      content:
        `Answer ${i + 1}: Here's what I know about topic ${i + 1}. `.repeat(20),
    })
  }

  return messages
}

test('estimateTotalTokens returns reasonable estimates', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'Short system prompt.' },
    { role: 'user', content: 'Hello!' },
    { role: 'assistant', content: 'Hi there!' },
  ]

  const tokens = estimateTotalTokens(messages)

  // "Short system prompt." = 20 chars -> ~5 tokens
  // "Hello!" = 6 chars -> ~2 tokens
  // "Hi there!" = 9 chars -> ~3 tokens
  // total ~10 tokens
  assert.ok(tokens > 0)
  assert.ok(tokens < 50)
})

test('estimateTotalTokens accounts for tool calls & thinking', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System.' },
    {
      role: 'assistant',
      content: 'Let me check.',
      thinking: 'I should read the file first to understand the structure.',
      tool_calls: [
        {
          function: {
            name: 'read_file',
            arguments: { path: 'src/main.ts' },
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_name: 'read_file',
      content: 'export function main() {}',
    },
  ]

  const tokensWithExtras = estimateTotalTokens(messages)

  const simpleMessages: OllamaMessage[] = [
    { role: 'system', content: 'System.' },
    { role: 'assistant', content: 'Let me check.' },
    {
      role: 'tool',
      tool_name: 'read_file',
      content: 'export function main() {}',
    },
  ]

  const tokensWithout = estimateTotalTokens(simpleMessages)

  assert.ok(tokensWithExtras > tokensWithout)
})

test('shouldCompact returns false for short conversations', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' },
  ]

  assert.equal(shouldCompact(messages), false)
})

test('shouldCompact returns false when below min message count', () =>
{
  // even w/ a tiny context window, don't compact if under minMessagesForCompaction
  const messages = buildConversation(5)
  const config: CompactionConfig = {
    contextWindow: 100,
    minRecentMessages: 2,
    minMessagesForCompaction: 20,
  }

  assert.equal(shouldCompact(messages, config), false)
})

test('shouldCompact returns true when context budget is exceeded', () =>
{
  const messages = buildConversation(30)
  const config: CompactionConfig = {
    contextWindow: 2_000,
    minRecentMessages: 5,
    minMessagesForCompaction: 10,
  }

  assert.equal(shouldCompact(messages, config), true)
})

test('splitForCompaction preserves system prompt & recent messages', () =>
{
  const messages = buildConversation(15)
  const config: CompactionConfig = {
    contextWindow: 4_000,
    minRecentMessages: 6,
    minMessagesForCompaction: 10,
  }

  const { toSummarize, toKeep } = splitForCompaction(messages, config)

  // system prompt should be in toKeep
  assert.equal(toKeep[0]!.role, 'system')

  // recent messages should be in toKeep (at least minRecentMessages)
  const nonSystemKeep = toKeep.filter((m) => m.role !== 'system')
  assert.ok(nonSystemKeep.length >= config.minRecentMessages)

  // toSummarize should not include system prompt
  assert.ok(!toSummarize.some((m) => m.role === 'system'))

  // all messages should be accounted for
  assert.equal(toSummarize.length + toKeep.length, messages.length)
})

test('splitForCompaction tries to split at user message boundary', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System.' },
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'tool', tool_name: 'read_file', content: 'file content' },
    { role: 'assistant', content: 'A1 continued' },
    { role: 'user', content: 'Q2' },
    { role: 'assistant', content: 'A2' },
    { role: 'user', content: 'Q3' },
    { role: 'assistant', content: 'A3' },
    { role: 'user', content: 'Q4' },
    { role: 'assistant', content: 'A4' },
  ]

  const config: CompactionConfig = {
    contextWindow: 4_000,
    minRecentMessages: 4,
    minMessagesForCompaction: 5,
  }

  const { toSummarize, toKeep } = splitForCompaction(messages, config)

  // toKeep should start w/ system prompt, followed by a user message
  assert.equal(toKeep[0]!.role, 'system')
  if (toKeep.length > 1)
  {
    // the first non-system message in toKeep should be a user message (clean split)
    assert.equal(toKeep[1]!.role, 'user')
  }

  assert.ok(toSummarize.length > 0)
})

test('splitForCompaction returns empty toSummarize when messages are few', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' },
  ]

  const config: CompactionConfig = {
    ...DEFAULT_COMPACTION_CONFIG,
    minRecentMessages: 10,
  }

  const { toSummarize, toKeep } = splitForCompaction(messages, config)

  assert.equal(toSummarize.length, 0)
  assert.deepEqual(toKeep, messages)
})

test('buildCompactionPrompt uses structured handoff template', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'user', content: 'Read package.json' },
    {
      role: 'assistant',
      content: "I'll read it.",
      tool_calls: [
        {
          function: {
            name: 'read_file',
            arguments: { path: 'package.json' },
          },
        },
      ],
    },
    { role: 'tool', tool_name: 'read_file', content: '{"name":"test"}' },
    { role: 'assistant', content: "The package is named 'test'." },
  ]

  const prompt = buildCompactionPrompt(messages)

  // should use the structured handoff format
  assert.match(prompt, /handoff/)
  assert.match(prompt, /## Goal/)
  assert.match(prompt, /## Key Decisions & Constraints/)
  assert.match(prompt, /## Work Completed/)
  assert.match(prompt, /## Work In Progress \/ Remaining/)
  assert.match(prompt, /## Relevant Files/)
  // should include the conversation content
  assert.match(prompt, /User: Read package\.json/)
  assert.match(prompt, /read_file/)
  assert.match(prompt, /package is named/)
})

test('buildCompactionPrompt truncates long tool results', () =>
{
  const longContent = 'x'.repeat(1000)
  const messages: OllamaMessage[] = [
    { role: 'tool', tool_name: 'read_file', content: longContent },
  ]

  const prompt = buildCompactionPrompt(messages)

  // the full 1000-char content should not appear in the prompt
  assert.ok(!prompt.includes(longContent))
  // but a truncated version should (300 char limit + ellipsis)
  assert.match(prompt, /…/)
})

test('buildCompactedMessages creates valid conversation structure', () =>
{
  const systemMsg: OllamaMessage = { role: 'system', content: 'You are Coral.' }
  const summary =
    '- User asked about the codebase\n- Read several files\n- Made edits to main.ts'
  const recentMessages: OllamaMessage[] = [
    { role: 'system', content: 'You are Coral.' },
    { role: 'user', content: 'Now fix the bug' },
    { role: 'assistant', content: "I'll fix it." },
  ]

  const compacted = buildCompactedMessages(systemMsg, summary, recentMessages)

  // first message should be system prompt
  assert.equal(compacted[0]!.role, 'system')
  assert.equal(compacted[0]!.content, 'You are Coral.')

  // second should be summary as user message w/ handoff prefix
  assert.equal(compacted[1]!.role, 'user')
  assert.match(compacted[1]!.content, /Conversation handoff/)
  assert.match(compacted[1]!.content, /codebase/)

  // third should be the first recent user message (no ack message)
  assert.equal(compacted[2]!.role, 'user')
  assert.equal(compacted[2]!.content, 'Now fix the bug')
  assert.equal(compacted[3]!.role, 'assistant')
  assert.equal(compacted[3]!.content, "I'll fix it.")

  // no duplicate system prompts
  const systemCount = compacted.filter((m) => m.role === 'system').length
  assert.equal(systemCount, 1)
})

test('buildCompactedMessages deduplicates system messages from recent', () =>
{
  const systemMsg: OllamaMessage = { role: 'system', content: 'System prompt' }
  const summary = 'Summary of old conversation.'
  const recentMessages: OllamaMessage[] = [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'Question' },
  ]

  const compacted = buildCompactedMessages(systemMsg, summary, recentMessages)

  const systemCount = compacted.filter((m) => m.role === 'system').length
  assert.equal(systemCount, 1)
})

// ── pruning tests ─────────────────────────────────────────────────────

test('shouldPrune returns false when below message threshold', () =>
{
  const config: CompactionConfig = {
    contextWindow: 100,
    minRecentMessages: 5,
    minMessagesForCompaction: 20,
  }

  // only 5 messages — below MIN_MESSAGES_FOR_PRUNING (10)
  assert.equal(shouldPrune(5, 999, config), false)
})

test('shouldPrune returns true when tokens exceed 75% of context window', () =>
{
  const config: CompactionConfig = {
    contextWindow: 1_000,
    minRecentMessages: 5,
    minMessagesForCompaction: 20,
  }

  // 800 > 1000 * 0.75 (750)
  assert.equal(shouldPrune(15, 800, config), true)
  // 700 < 750
  assert.equal(shouldPrune(15, 700, config), false)
})

test('pruneToolResults replaces old tool results w/ markers', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System.' },
    { role: 'user', content: 'Q1' },
    {
      role: 'assistant',
      content: 'A1',
      tool_calls: [
        { function: { name: 'read_file', arguments: { path: 'a.ts' } } },
      ],
    },
    {
      role: 'tool',
      tool_name: 'read_file',
      content:
        'content of a.ts - '.repeat(20) +
        'this is a very long file with lots of code that takes many tokens',
    },
    { role: 'user', content: 'Q2' },
    {
      role: 'assistant',
      content: 'A2',
      tool_calls: [
        { function: { name: 'read_file', arguments: { path: 'b.ts' } } },
      ],
    },
    { role: 'tool', tool_name: 'read_file', content: 'content of b.ts' },
    { role: 'user', content: 'Q3' },
    {
      role: 'assistant',
      content: 'A3',
      tool_calls: [
        { function: { name: 'bash', arguments: { command: 'ls' } } },
      ],
    },
    { role: 'tool', tool_name: 'bash', content: 'file1 file2 file3' },
  ]

  // protect last 2 tool results — should prune only the first one
  const { prunedMessages, prunedCount, tokensSaved } = pruneToolResults(
    messages,
    2
  )

  assert.equal(prunedCount, 1)
  assert.ok(tokensSaved > 0)

  // first tool result should be pruned
  assert.match(prunedMessages[3]!.content, /tool result pruned/)
  assert.match(prunedMessages[3]!.content, /read_file/)

  // last two tool results should be untouched
  assert.equal(prunedMessages[6]!.content, 'content of b.ts')
  assert.equal(prunedMessages[9]!.content, 'file1 file2 file3')

  // assistant messages should be untouched
  assert.ok(prunedMessages[2]!.tool_calls!.length > 0)
})

test('pruneToolResults does not modify assistant messages', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System.' },
    {
      role: 'assistant',
      content: 'Response w/ tool calls',
      tool_calls: [
        { function: { name: 'bash', arguments: { command: 'ls' } } },
      ],
    },
    { role: 'tool', tool_name: 'bash', content: 'output' },
  ]

  const { prunedMessages } = pruneToolResults(messages, 0)

  // even w/ protectCount=0, assistant messages stay
  assert.equal(prunedMessages[1]!.role, 'assistant')
  assert.equal(prunedMessages[1]!.content, 'Response w/ tool calls')
  assert.ok(prunedMessages[1]!.tool_calls!.length > 0)

  // tool result should be pruned (protectCount=0)
  assert.match(prunedMessages[2]!.content, /tool result pruned/)
})

test('pruneToolResults does not mutate the input array', () =>
{
  const original: OllamaMessage[] = [
    { role: 'system', content: 'System.' },
    { role: 'tool', tool_name: 'read_file', content: 'file content here' },
  ]

  const originalContent = original[1]!.content
  pruneToolResults(original, 0)

  assert.equal(original[1]!.content, originalContent)
})

test('buildPruneMarker includes tool name & token estimate', () =>
{
  const msg: OllamaMessage = {
    role: 'tool',
    tool_name: 'read_file',
    content: 'export function hello() { return "world" }',
  }

  const marker = buildPruneMarker(msg)

  assert.match(marker, /tool result pruned/)
  assert.match(marker, /read_file/)
  assert.match(marker, /~\d+ tokens/)
})

test('buildPruneMarker truncates long content preview', () =>
{
  const msg: OllamaMessage = {
    role: 'tool',
    tool_name: 'bash',
    content: 'x'.repeat(200),
  }

  const marker = buildPruneMarker(msg)

  // the marker should be much shorter than the original content
  assert.ok(marker.length < 200)
  assert.match(marker, /…/)
})

test('buildPruneMarker falls back to "tool" when tool_name is missing', () =>
{
  const msg: OllamaMessage = {
    role: 'tool',
    content: 'some output',
  }

  const marker = buildPruneMarker(msg)

  assert.match(marker, /tool result pruned — tool:/)
})

// ── thinking strip tests ──────────────────────────────────────────────

test('stripThinkingForCompaction removes thinking & adds note', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'user', content: 'Hello' },
    {
      role: 'assistant',
      content: 'The answer is 42.',
      thinking: 'Let me think about this deeply...',
    },
    { role: 'assistant', content: 'Simple response.' },
  ]

  const stripped = stripThinkingForCompaction(messages)

  // user messages unchanged
  assert.equal(stripped[0]!.content, 'Hello')

  // assistant w/ thinking: thinking removed, note prepended
  assert.equal(stripped[1]!.thinking, undefined)
  assert.match(stripped[1]!.content, /\[reasoning was used\]/)
  assert.match(stripped[1]!.content, /The answer is 42\./)

  // assistant w/o thinking: unchanged
  assert.equal(stripped[2]!.content, 'Simple response.')
  assert.equal(stripped[2]!.thinking, undefined)
})

test('stripThinkingForCompaction handles empty content w/ thinking', () =>
{
  const messages: OllamaMessage[] = [
    {
      role: 'assistant',
      content: '',
      thinking: 'Some deep reasoning',
    },
  ]

  const stripped = stripThinkingForCompaction(messages)

  assert.equal(stripped[0]!.content, '[reasoning was used]')
  assert.equal(stripped[0]!.thinking, undefined)
})

test('stripThinkingForCompaction does not mutate original messages', () =>
{
  const messages: OllamaMessage[] = [
    {
      role: 'assistant',
      content: 'Answer',
      thinking: 'Thoughts',
    },
  ]

  stripThinkingForCompaction(messages)

  // original should still have thinking
  assert.equal(messages[0]!.thinking, 'Thoughts')
  assert.equal(messages[0]!.content, 'Answer')
})
