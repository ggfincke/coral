// tests/compaction.test.ts
// tests for conversation compaction

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { OllamaMessage } from "../src/ollama/client.js";
import {
  estimateTotalTokens,
  shouldCompact,
  splitForCompaction,
  buildCompactionPrompt,
  buildCompactedMessages,
  DEFAULT_COMPACTION_CONFIG,
  type CompactionConfig,
} from "../src/agent/compaction.js";

// helper to build a conversation w/ N user-assistant pairs
function buildConversation(turns: number): OllamaMessage[] {
  const messages: OllamaMessage[] = [
    { role: "system", content: "You are a helpful assistant." },
  ];

  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `Question ${i + 1}: What about topic ${i + 1}?` });
    messages.push({ role: "assistant", content: `Answer ${i + 1}: Here's what I know about topic ${i + 1}. `.repeat(20) });
  }

  return messages;
}

test("estimateTotalTokens returns reasonable estimates", () => {
  const messages: OllamaMessage[] = [
    { role: "system", content: "Short system prompt." },
    { role: "user", content: "Hello!" },
    { role: "assistant", content: "Hi there!" },
  ];

  const tokens = estimateTotalTokens(messages);

  // "Short system prompt." = 20 chars -> ~5 tokens
  // "Hello!" = 6 chars -> ~2 tokens
  // "Hi there!" = 9 chars -> ~3 tokens
  // total ~10 tokens
  assert.ok(tokens > 0);
  assert.ok(tokens < 50);
});

test("estimateTotalTokens accounts for tool calls & thinking", () => {
  const messages: OllamaMessage[] = [
    { role: "system", content: "System." },
    {
      role: "assistant",
      content: "Let me check.",
      thinking: "I should read the file first to understand the structure.",
      tool_calls: [{
        function: {
          name: "read_file",
          arguments: { path: "src/main.ts" },
        },
      }],
    },
    { role: "tool", tool_name: "read_file", content: "export function main() {}" },
  ];

  const tokensWithExtras = estimateTotalTokens(messages);

  const simpleMessages: OllamaMessage[] = [
    { role: "system", content: "System." },
    { role: "assistant", content: "Let me check." },
    { role: "tool", tool_name: "read_file", content: "export function main() {}" },
  ];

  const tokensWithout = estimateTotalTokens(simpleMessages);

  assert.ok(tokensWithExtras > tokensWithout);
});

test("shouldCompact returns false for short conversations", () => {
  const messages: OllamaMessage[] = [
    { role: "system", content: "System." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi" },
  ];

  assert.equal(shouldCompact(messages), false);
});

test("shouldCompact returns false when below min message count", () => {
  // even w/ a tiny context window, don't compact if under minMessagesForCompaction
  const messages = buildConversation(5);
  const config: CompactionConfig = {
    contextWindow: 100,
    minRecentMessages: 2,
    minMessagesForCompaction: 20,
  };

  assert.equal(shouldCompact(messages, config), false);
});

test("shouldCompact returns true when context budget is exceeded", () => {
  const messages = buildConversation(30);
  const config: CompactionConfig = {
    contextWindow: 2_000,
    minRecentMessages: 5,
    minMessagesForCompaction: 10,
  };

  assert.equal(shouldCompact(messages, config), true);
});

test("splitForCompaction preserves system prompt & recent messages", () => {
  const messages = buildConversation(15);
  const config: CompactionConfig = {
    contextWindow: 4_000,
    minRecentMessages: 6,
    minMessagesForCompaction: 10,
  };

  const { toSummarize, toKeep } = splitForCompaction(messages, config);

  // system prompt should be in toKeep
  assert.equal(toKeep[0]!.role, "system");

  // recent messages should be in toKeep (at least minRecentMessages)
  const nonSystemKeep = toKeep.filter((m) => m.role !== "system");
  assert.ok(nonSystemKeep.length >= config.minRecentMessages);

  // toSummarize should not include system prompt
  assert.ok(!toSummarize.some((m) => m.role === "system"));

  // all messages should be accounted for
  assert.equal(
    toSummarize.length + toKeep.length,
    messages.length,
  );
});

test("splitForCompaction tries to split at user message boundary", () => {
  const messages: OllamaMessage[] = [
    { role: "system", content: "System." },
    { role: "user", content: "Q1" },
    { role: "assistant", content: "A1" },
    { role: "tool", tool_name: "read_file", content: "file content" },
    { role: "assistant", content: "A1 continued" },
    { role: "user", content: "Q2" },
    { role: "assistant", content: "A2" },
    { role: "user", content: "Q3" },
    { role: "assistant", content: "A3" },
    { role: "user", content: "Q4" },
    { role: "assistant", content: "A4" },
  ];

  const config: CompactionConfig = {
    contextWindow: 4_000,
    minRecentMessages: 4,
    minMessagesForCompaction: 5,
  };

  const { toSummarize, toKeep } = splitForCompaction(messages, config);

  // toKeep should start w/ system prompt, followed by a user message
  assert.equal(toKeep[0]!.role, "system");
  if (toKeep.length > 1) {
    // the first non-system message in toKeep should be a user message (clean split)
    assert.equal(toKeep[1]!.role, "user");
  }

  assert.ok(toSummarize.length > 0);
});

test("splitForCompaction returns empty toSummarize when messages are few", () => {
  const messages: OllamaMessage[] = [
    { role: "system", content: "System." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi" },
  ];

  const config: CompactionConfig = {
    ...DEFAULT_COMPACTION_CONFIG,
    minRecentMessages: 10,
  };

  const { toSummarize, toKeep } = splitForCompaction(messages, config);

  assert.equal(toSummarize.length, 0);
  assert.deepEqual(toKeep, messages);
});

test("buildCompactionPrompt formats messages into a readable summary request", () => {
  const messages: OllamaMessage[] = [
    { role: "user", content: "Read package.json" },
    {
      role: "assistant",
      content: "I'll read it.",
      tool_calls: [{
        function: {
          name: "read_file",
          arguments: { path: "package.json" },
        },
      }],
    },
    { role: "tool", tool_name: "read_file", content: '{"name":"test"}' },
    { role: "assistant", content: "The package is named 'test'." },
  ];

  const prompt = buildCompactionPrompt(messages);

  assert.match(prompt, /Summarize/);
  assert.match(prompt, /User: Read package\.json/);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /package is named/);
});

test("buildCompactionPrompt truncates long tool results", () => {
  const longContent = "x".repeat(1000);
  const messages: OllamaMessage[] = [
    { role: "tool", tool_name: "read_file", content: longContent },
  ];

  const prompt = buildCompactionPrompt(messages);

  // should be truncated, not include the full 1000 chars
  assert.ok(prompt.length < longContent.length);
  assert.match(prompt, /…/);
});

test("buildCompactedMessages creates valid conversation structure", () => {
  const systemMsg: OllamaMessage = { role: "system", content: "You are Coral." };
  const summary = "- User asked about the codebase\n- Read several files\n- Made edits to main.ts";
  const recentMessages: OllamaMessage[] = [
    { role: "system", content: "You are Coral." },
    { role: "user", content: "Now fix the bug" },
    { role: "assistant", content: "I'll fix it." },
  ];

  const compacted = buildCompactedMessages(systemMsg, summary, recentMessages);

  // first message should be system prompt
  assert.equal(compacted[0]!.role, "system");
  assert.equal(compacted[0]!.content, "You are Coral.");

  // second should be summary as user message
  assert.equal(compacted[1]!.role, "user");
  assert.match(compacted[1]!.content, /Previous conversation summary/);
  assert.match(compacted[1]!.content, /codebase/);

  // third should be assistant acknowledgment
  assert.equal(compacted[2]!.role, "assistant");
  assert.match(compacted[2]!.content, /context/i);

  // then recent messages (minus the system prompt from recentMessages)
  assert.equal(compacted[3]!.role, "user");
  assert.equal(compacted[3]!.content, "Now fix the bug");
  assert.equal(compacted[4]!.role, "assistant");
  assert.equal(compacted[4]!.content, "I'll fix it.");

  // no duplicate system prompts
  const systemCount = compacted.filter((m) => m.role === "system").length;
  assert.equal(systemCount, 1);
});

test("buildCompactedMessages deduplicates system messages from recent", () => {
  const systemMsg: OllamaMessage = { role: "system", content: "System prompt" };
  const summary = "Summary of old conversation.";
  const recentMessages: OllamaMessage[] = [
    { role: "system", content: "System prompt" },
    { role: "user", content: "Question" },
  ];

  const compacted = buildCompactedMessages(systemMsg, summary, recentMessages);

  const systemCount = compacted.filter((m) => m.role === "system").length;
  assert.equal(systemCount, 1);
});
