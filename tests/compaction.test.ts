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

test('splitForCompaction preserves system prompt and recent context', () =>
{
  const messages = buildConversation(15)
  const config: CompactionConfig = {
    contextWindow: 4_000,
    minRecentMessages: 6,
    minMessagesForCompaction: 10,
  }

  const { toSummarize, toKeep } = splitForCompaction(messages, config)

  assert.equal(toKeep[0]!.role, 'system')
  assert.ok(!toSummarize.some((message) => message.role === 'system'))
  assert.ok(toKeep.filter((message) => message.role !== 'system').length >= 6)
  assert.equal(toSummarize.length + toKeep.length, messages.length)
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

test('buildCompactedMessages resumes from one system prompt and recent messages', () =>
{
  const systemMessage: OllamaMessage = {
    role: 'system',
    content: 'You are Coral.',
  }
  const recentMessages: OllamaMessage[] = [
    { role: 'system', content: 'You are Coral.' },
    { role: 'user', content: 'Now fix the bug' },
    { role: 'assistant', content: "I'll fix it." },
  ]

  const compacted = buildCompactedMessages(
    systemMessage,
    '- Read the repo\n- Found the bug',
    recentMessages
  )

  assert.equal(
    compacted.filter((message) => message.role === 'system').length,
    1
  )
  assert.match(compacted[1]!.content, /Conversation handoff/)
  assert.equal(compacted[2]!.content, 'Now fix the bug')
  assert.equal(compacted[3]!.content, "I'll fix it.")
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
