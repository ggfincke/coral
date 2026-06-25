// src/agent/compaction.ts
// two-layer conversation compaction — prune tool results first, then summarize

import type { OllamaMessage } from '../types/inference.js'
import { ellipsize } from '../utils/ellipsize.js'
import { CHARS_PER_TOKEN } from '../utils/limits.js'

// default context window size (tokens) — conservative floor for compaction
// estimates when the live num_ctx is unknown
const DEFAULT_CONTEXT_WINDOW = 32_768

// prune old tool results when estimated tokens exceed this fraction of context
export const PRUNE_THRESHOLD = 0.75

// trigger full summarization when estimated tokens exceed this fraction of context
export const SUMMARIZE_THRESHOLD = 0.9

// keep this many recent tool results untouched during pruning
export const PRUNE_PROTECT_COUNT = 6

// stop retrying summarization after this many consecutive failures
export const MAX_COMPACT_FAILURES = 2

// stable content prefix of a frozen summary block — used to both build the block
// & detect it on session restore. keep in sync w/ buildCompactedMessages
export const FROZEN_SUMMARY_MARKER = '[Conversation handoff'

// consolidate the accumulated frozen summaries into one once they exceed this —
// bounds prefix growth at the cost of a single cold prefill
export const MAX_FROZEN_SUMMARIES = 4

// minimum messages before pruning triggers
const MIN_MESSAGES_FOR_PRUNING = 10

// minimum messages before summarization triggers
const MIN_MESSAGES_FOR_COMPACTION = 20

// minimum recent messages to preserve verbatim during summarization
const MIN_RECENT_MESSAGES = 10

// compaction configuration
export interface CompactionConfig
{
  // model context window size in tokens (default: 32768)
  contextWindow: number
  // minimum recent messages to preserve verbatim
  minRecentMessages: number
  // minimum total messages before summarization triggers
  minMessagesForCompaction: number
}

// default compaction configuration
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  minRecentMessages: MIN_RECENT_MESSAGES,
  minMessagesForCompaction: MIN_MESSAGES_FOR_COMPACTION,
}

// result of a compaction operation
// 'pruned' = tool results replaced w/ markers, 'summarized' = model summary,
// 'trimmed' = oldest messages dropped after summarization failed (no summary)
export interface CompactionResult
{
  type: 'pruned' | 'summarized' | 'trimmed'
  beforeTokens: number
  afterTokens: number
  beforeMessages: number
  afterMessages: number
  // number of tool results replaced w/ markers (only for type 'pruned')
  prunedResults?: number
}

// estimate token count for a message
export function estimateMessageTokens(msg: OllamaMessage): number
{
  let chars = msg.content.length

  if (msg.thinking) chars += msg.thinking.length

  if (msg.tool_calls)
  {
    for (const call of msg.tool_calls)
    {
      chars += call.function.name.length
      chars += JSON.stringify(call.function.arguments).length
    }
  }

  if (msg.tool_name) chars += msg.tool_name.length

  return Math.ceil(chars / CHARS_PER_TOKEN)
}

// estimate total tokens for a list of messages
export function estimateTotalTokens(messages: OllamaMessage[]): number
{
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}

// check whether pruning should trigger
export function shouldPrune(
  messageCount: number,
  totalTokens: number,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
): boolean
{
  if (messageCount < MIN_MESSAGES_FOR_PRUNING) return false
  return totalTokens > config.contextWindow * PRUNE_THRESHOLD
}

// check whether summarization should trigger from a cached token estimate
export function shouldCompactByTotal(
  messageCount: number,
  totalTokens: number,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
): boolean
{
  if (messageCount < config.minMessagesForCompaction) return false
  return totalTokens > config.contextWindow * SUMMARIZE_THRESHOLD
}

// build a prune marker for a tool result being replaced
function buildPruneMarker(msg: OllamaMessage): string
{
  const toolName = msg.tool_name ?? 'tool'
  const tokens = estimateMessageTokens(msg)

  // take the first 60 chars of content as a preview
  const preview = ellipsize(msg.content, 60)

  return `[tool result pruned — ${toolName}: ${preview}, ~${tokens} tokens]`
}

// prune old tool results, replacing them w/ compact markers
// keeps the last `protectCount` tool-role messages untouched & never touches
// messages before `startIndex` (the frozen prefix), so their KV cache survives
// returns a new array — does NOT mutate the input
export function pruneToolResults(
  messages: OllamaMessage[],
  protectCount: number = PRUNE_PROTECT_COUNT,
  startIndex = 0
): {
  prunedMessages: OllamaMessage[]
  prunedCount: number
}
{
  // find tool-role message indices at or after the frozen prefix
  const toolIndices: number[] = []
  for (let i = startIndex; i < messages.length; i++)
  {
    if (messages[i]!.role === 'tool') toolIndices.push(i)
  }

  // determine which indices are protected (the last N by position)
  const protectedSet = new Set(
    protectCount > 0 ? toolIndices.slice(-protectCount) : []
  )

  let prunedCount = 0
  const prunedMessages: OllamaMessage[] = []

  for (let i = 0; i < messages.length; i++)
  {
    const msg = messages[i]!

    if (msg.role === 'tool' && i >= startIndex && !protectedSet.has(i))
    {
      const marker = buildPruneMarker(msg)
      const prunedMsg: OllamaMessage = {
        role: 'tool',
        content: marker,
        tool_name: msg.tool_name,
      }

      prunedMessages.push(prunedMsg)
      prunedCount++
    }
    else
    {
      prunedMessages.push(msg)
    }
  }

  return { prunedMessages, prunedCount }
}

// strip thinking blocks from messages before feeding to the summarizer
// clones messages w/ thinking removed & a note prepended to content
export function stripThinkingForCompaction(
  messages: OllamaMessage[]
): OllamaMessage[]
{
  return messages.map((msg) =>
  {
    if (!msg.thinking) return msg

    const rest = { ...msg }
    delete rest.thinking

    return {
      ...rest,
      content: msg.content
        ? `[reasoning was used]\n${msg.content}`
        : '[reasoning was used]',
    }
  })
}

// format messages into a readable transcript for the summarizer
function formatMessagesForSummary(messages: OllamaMessage[]): string
{
  const lines: string[] = []

  for (const msg of messages)
  {
    switch (msg.role)
    {
      case 'user':
        lines.push(`User: ${msg.content}`)
        break
      case 'assistant':
        if (msg.content)
        {
          lines.push(`Assistant: ${msg.content}`)
        }
        if (msg.tool_calls?.length)
        {
          for (const call of msg.tool_calls)
          {
            lines.push(
              `  [called ${call.function.name}(${JSON.stringify(call.function.arguments)})]`
            )
          }
        }
        break
      case 'tool':
      {
        // truncate long tool results for the summary
        const content = ellipsize(msg.content, 300)
        lines.push(`  [${msg.tool_name ?? 'tool'} result] ${content}`)
        break
      }
    }
  }

  return lines.join('\n')
}

// build the compaction prompt — structured handoff for the summarizer
export function buildCompactionPrompt(
  messagesToSummarize: OllamaMessage[]
): string
{
  const formatted = formatMessagesForSummary(messagesToSummarize)

  return `Summarize this conversation into a structured handoff document. Another instance of you will continue the work using only this summary as context.

Use this exact format:

## Goal
What the user is trying to accomplish (1-2 sentences)

## Key Decisions & Constraints
- Important decisions made during the conversation
- Constraints or preferences the user specified

## Work Completed
- Files read, created, or modified (w/ paths)
- Commands run & their outcomes
- Problems solved

## Work In Progress / Remaining
- What still needs to be done
- Any known blockers or open questions

## Relevant Files
- List file paths that are central to the current task

Be concise but complete. Omit pleasantries. Focus on facts & state.

Conversation to summarize:

${formatted}`
}

// count the frozen-prefix length: the system prompt plus any contiguous frozen
// summary blocks that follow it. used to recover the boundary on session restore
export function countFrozenPrefix(messages: OllamaMessage[]): number
{
  if (messages.length === 0) return 0

  let count = 1
  for (let i = 1; i < messages.length; i++)
  {
    const msg = messages[i]!
    if (msg.role === 'user' && msg.content.startsWith(FROZEN_SUMMARY_MARKER))
    {
      count++
    }
    else
    {
      break
    }
  }

  return count
}

// split the live region (messages after the frozen prefix) into "old" (to
// summarize) & "recent" (to keep verbatim) — never touches the frozen prefix,
// so its KV cache survives the rebuild
export function splitForCompaction(
  messages: OllamaMessage[],
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
  frozenPrefixLength = 1
): { toSummarize: OllamaMessage[]; toKeep: OllamaMessage[] }
{
  const live = messages.slice(frozenPrefixLength)

  if (live.length <= config.minRecentMessages)
  {
    return { toSummarize: [], toKeep: live }
  }

  // find a clean split point — try to split at a user message boundary
  // so we don't break mid-turn (assistant + tool calls + tool results)
  const splitTarget = live.length - config.minRecentMessages

  // walk forward from the target to find a user message (start of a turn)
  let splitIndex = splitTarget
  while (splitIndex < live.length && live[splitIndex]?.role !== 'user')
  {
    splitIndex++
  }

  // if we couldn't find a user message boundary, fall back to the target
  if (splitIndex >= live.length)
  {
    splitIndex = splitTarget
  }

  return {
    toSummarize: live.slice(0, splitIndex),
    toKeep: live.slice(splitIndex),
  }
}

// build the compacted array: the frozen prefix stays byte-identical, the new
// summary is appended as another frozen block, then the kept live tail follows.
// keeping the prefix stable lets llama.cpp reuse its KV cache through it
export function buildCompactedMessages(
  frozenPrefix: OllamaMessage[],
  summary: string,
  toKeep: OllamaMessage[]
): OllamaMessage[]
{
  const summaryMessage: OllamaMessage = {
    role: 'user',
    content: `${FROZEN_SUMMARY_MARKER} — you are continuing a prior session. Use this context to inform your work, but do not respond to it directly.]\n\n${summary}`,
  }

  // filter out system messages from the kept tail — the prefix holds the system
  const recent = toKeep.filter((m) => m.role !== 'system')

  return [...frozenPrefix, summaryMessage, ...recent]
}
