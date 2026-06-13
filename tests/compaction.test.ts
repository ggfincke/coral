// tests/compaction.test.ts
// tests for conversation compaction

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { OllamaMessage } from '../src/types/inference.js'
import {
  shouldCompact,
  splitForCompaction,
  buildCompactionPrompt,
  buildCompactedMessages,
  pruneToolResults,
  stripThinkingForCompaction,
  countFrozenPrefix,
  FROZEN_SUMMARY_MARKER,
  MAX_FROZEN_SUMMARIES,
  type CompactionConfig,
} from '../src/agent/compaction.js'

function buildConversation(turns: number): OllamaMessage[]
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
  ]

  for (let i = 0; i < turns; i++)
  {
    messages.push({ role: 'user', content: `Question ${i + 1}` })
    messages.push({
      role: 'assistant',
      content: `Answer ${i + 1}. `.repeat(80),
    })
  }

  return messages
}

test('shouldCompact triggers when the conversation exceeds budget', () =>
{
  const messages = buildConversation(30)
  const config: CompactionConfig = {
    contextWindow: 2_000,
    minRecentMessages: 5,
    minMessagesForCompaction: 10,
  }

  assert.equal(shouldCompact(messages, config), true)
})

test('splitForCompaction splits the live region and never touches the prefix', () =>
{
  const messages = buildConversation(15)
  const config: CompactionConfig = {
    contextWindow: 4_000,
    minRecentMessages: 6,
    minMessagesForCompaction: 10,
  }

  // default frozenPrefixLength = 1 (system only)
  const { toSummarize, toKeep } = splitForCompaction(messages, config, 1)

  // neither side carries the system prompt — the prefix is held out
  assert.ok(!toSummarize.some((message) => message.role === 'system'))
  assert.ok(!toKeep.some((message) => message.role === 'system'))
  // together they reconstruct the live region exactly
  assert.equal(toSummarize.length + toKeep.length, messages.length - 1)
  assert.ok(toKeep.length >= 6)
})

test('splitForCompaction holds out an extended frozen prefix', () =>
{
  const config: CompactionConfig = {
    contextWindow: 4_000,
    minRecentMessages: 2,
    minMessagesForCompaction: 4,
  }
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: `${FROZEN_SUMMARY_MARKER} ...]\n\nsummary 1` },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ]

  // frozenPrefixLength = 2 (system + one summary block)
  const { toSummarize, toKeep } = splitForCompaction(messages, config, 2)

  // the summary block is never re-summarized
  assert.ok(
    !toSummarize.some((m) => m.content.startsWith(FROZEN_SUMMARY_MARKER))
  )
  assert.equal(toSummarize.length + toKeep.length, messages.length - 2)
})

test('buildCompactionPrompt creates a useful handoff without huge tool output', () =>
{
  const longOutput = 'x'.repeat(1000)
  const messages: OllamaMessage[] = [
    { role: 'user', content: 'Read package.json' },
    {
      role: 'assistant',
      content: "I'll read it.",
      tool_calls: [
        {
          function: { name: 'read_file', arguments: { path: 'package.json' } },
        },
      ],
    },
    { role: 'tool', tool_name: 'read_file', content: longOutput },
    { role: 'assistant', content: 'The package is named coral.' },
  ]

  const prompt = buildCompactionPrompt(messages)

  assert.match(prompt, /## Goal/)
  assert.match(prompt, /## Work Completed/)
  assert.match(prompt, /read_file/)
  assert.match(prompt, /package is named coral/)
  assert.ok(!prompt.includes(longOutput))
})

test('buildCompactedMessages appends the summary after the frozen prefix', () =>
{
  const system: OllamaMessage = { role: 'system', content: 'You are Coral.' }
  const toKeep: OllamaMessage[] = [
    { role: 'user', content: 'Now fix the bug' },
    { role: 'assistant', content: "I'll fix it." },
  ]

  const compacted = buildCompactedMessages(
    [system],
    '- Read the repo\n- Found the bug',
    toKeep
  )

  assert.equal(
    compacted.filter((message) => message.role === 'system').length,
    1
  )
  assert.equal(compacted[0]!.content, 'You are Coral.')
  assert.match(compacted[1]!.content, /Conversation handoff/)
  assert.equal(compacted[2]!.content, 'Now fix the bug')
  assert.equal(compacted[3]!.content, "I'll fix it.")
})

test('countFrozenPrefix counts system plus contiguous summary blocks', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: `${FROZEN_SUMMARY_MARKER} ...]\n\nsummary 1` },
    { role: 'user', content: `${FROZEN_SUMMARY_MARKER} ...]\n\nsummary 2` },
    { role: 'user', content: 'a normal question' },
    { role: 'assistant', content: 'answer' },
  ]

  assert.equal(countFrozenPrefix(messages), 3)
})

test('successive append compactions keep the frozen prefix byte-stable', () =>
{
  const system: OllamaMessage = { role: 'system', content: 'You are Coral.' }
  const config: CompactionConfig = {
    contextWindow: 4_000,
    minRecentMessages: 2,
    minMessagesForCompaction: 4,
  }

  const turn = (n: number): OllamaMessage[] => [
    { role: 'user', content: `q${n}` },
    { role: 'assistant', content: `a${n}` },
  ]

  // first compaction — frozen prefix is just the system prompt
  let messages: OllamaMessage[] = [system, ...turn(1), ...turn(2), ...turn(3)]
  const split1 = splitForCompaction(messages, config, 1)
  messages = buildCompactedMessages(
    messages.slice(0, 1),
    'summary one',
    split1.toKeep
  )
  const fplAfterFirst = 2
  const prefixAfterFirst = messages.slice(0, fplAfterFirst)
  assert.equal(countFrozenPrefix(messages), fplAfterFirst)

  // more turns arrive, then a second compaction appends another block
  messages = [...messages, ...turn(4), ...turn(5)]
  const split2 = splitForCompaction(messages, config, fplAfterFirst)
  messages = buildCompactedMessages(
    messages.slice(0, fplAfterFirst),
    'summary two',
    split2.toKeep
  )

  // the prefix that existed after the first compaction is byte-identical now —
  // this is what lets the KV cache survive the second compaction
  assert.deepEqual(messages.slice(0, fplAfterFirst), prefixAfterFirst)
  assert.equal(countFrozenPrefix(messages), 3)
  assert.equal(messages[0]!.content, 'You are Coral.')
})

test('consolidation collapses capped summary blocks back into one', () =>
{
  const config: CompactionConfig = {
    contextWindow: 4_000,
    minRecentMessages: 2,
    minMessagesForCompaction: 4,
  }

  // a session that has hit the cap: system + MAX_FROZEN_SUMMARIES summary blocks
  const system: OllamaMessage = { role: 'system', content: 'You are Coral.' }
  const summaries: OllamaMessage[] = Array.from(
    { length: MAX_FROZEN_SUMMARIES },
    (_unused, i) => ({
      role: 'user' as const,
      content: `${FROZEN_SUMMARY_MARKER} ...]\n\nsummary ${i + 1}`,
    })
  )
  const messages: OllamaMessage[] = [
    system,
    ...summaries,
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ]

  // the frozen-prefix length is past the cap, so the agent consolidates from
  // the system prompt (splitFrom = 1) instead of appending
  const frozenPrefixLength = countFrozenPrefix(messages)
  assert.equal(frozenPrefixLength - 1 >= MAX_FROZEN_SUMMARIES, true)

  const { toSummarize, toKeep } = splitForCompaction(messages, config, 1)

  // consolidation feeds the prior summary blocks back through the summarizer
  assert.ok(
    toSummarize.some((m) => m.content.startsWith(FROZEN_SUMMARY_MARKER))
  )

  const consolidated = buildCompactedMessages(
    messages.slice(0, 1),
    'one consolidated summary',
    toKeep
  )

  // the many summary blocks collapse to exactly one — prefix growth is bounded
  assert.equal(countFrozenPrefix(consolidated), 2)
  assert.equal(consolidated[0]!.content, 'You are Coral.')
  assert.match(consolidated[1]!.content, /Conversation handoff/)
})

test('pruneToolResults removes old large tool results but keeps recent ones', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'System.' },
    { role: 'tool', tool_name: 'read_file', content: 'old file '.repeat(80) },
    { role: 'user', content: 'Q2' },
    { role: 'tool', tool_name: 'bash', content: 'recent output' },
  ]

  const { prunedMessages, prunedCount, tokensSaved } = pruneToolResults(
    messages,
    1
  )

  assert.equal(prunedCount, 1)
  assert.ok(tokensSaved > 0)
  assert.match(prunedMessages[1]!.content, /tool result pruned/)
  assert.equal(prunedMessages[3]!.content, 'recent output')
})

test('stripThinkingForCompaction removes reasoning while preserving answers', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'user', content: 'Hello' },
    {
      role: 'assistant',
      content: 'The answer is 42.',
      thinking: 'Private reasoning',
    },
  ]

  const stripped = stripThinkingForCompaction(messages)

  assert.equal(stripped[0]!.content, 'Hello')
  assert.equal(stripped[1]!.thinking, undefined)
  assert.match(stripped[1]!.content, /\[reasoning was used\]/)
  assert.match(stripped[1]!.content, /The answer is 42\./)
})
