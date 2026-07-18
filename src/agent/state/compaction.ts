// src/agent/state/compaction.ts
// conversation compaction and summary shaping

import type { OllamaMessage } from '../../types/inference.js'
import { ellipsize } from '../../utils/ellipsize.js'
import { estimateModelRequestMessageTokens } from '../request/projection.js'

// use a conservative context window when the live value is unknown
const DEFAULT_CONTEXT_WINDOW = 32_768

// prune old tool results after this fraction of context is used
const PRUNE_THRESHOLD = 0.75

// trigger summarization after this fraction of context is used
const SUMMARIZE_THRESHOLD = 0.9

// keep this many recent tool results during pruning
const PRUNE_PROTECT_COUNT = 6

// stop retrying summarization after this many consecutive failures
export const MAX_COMPACT_FAILURES = 2

// keep this prefix stable so frozen summaries can be recognized on restore
export const FROZEN_SUMMARY_MARKER = '[Conversation handoff'

// consolidate frozen summaries after this count to bound prefix growth
export const MAX_FROZEN_SUMMARIES = 4

// require this many messages before pruning
const MIN_MESSAGES_FOR_PRUNING = 10

// require this many messages before summarization
const MIN_MESSAGES_FOR_COMPACTION = 20

// preserve this many recent messages verbatim during summarization
const MIN_RECENT_MESSAGES = 10

// compaction thresholds and retention settings
export interface CompactionConfig
{
  // model context window size in tokens
  contextWindow: number
  // minimum recent messages to preserve verbatim
  minRecentMessages: number
  // minimum total messages before summarization triggers
  minMessagesForCompaction: number
}

// default compaction thresholds
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  minRecentMessages: MIN_RECENT_MESSAGES,
  minMessagesForCompaction: MIN_MESSAGES_FOR_COMPACTION,
}

// result of a compaction operation
export interface CompactionResult
{
  type: 'pruned' | 'summarized' | 'trimmed'
  beforeTokens: number
  afterTokens: number
  beforeMessages: number
  afterMessages: number
  // number of tool results replaced with markers
  prunedResults?: number
}

// estimate the token count for one message
export function estimateMessageTokens(msg: OllamaMessage): number
{
  return estimateModelRequestMessageTokens(msg)
}

// estimate the total token count for a message list
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

// check whether summarization should trigger from a cached estimate
export function shouldCompactByTotal(
  messageCount: number,
  totalTokens: number,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
): boolean
{
  if (messageCount < config.minMessagesForCompaction) return false
  return totalTokens > config.contextWindow * SUMMARIZE_THRESHOLD
}

// build a marker for a pruned tool result
function buildPruneMarker(msg: OllamaMessage): string
{
  const toolName = msg.tool_name ?? 'tool'
  const tokens = estimateMessageTokens(msg)

  // keep a short preview for the replacement marker
  const preview = ellipsize(msg.content, 60)

  return `[tool result pruned — ${toolName}: ${preview}, ~${tokens} tokens]`
}

// replace old tool results with compact markers while preserving the frozen prefix
// keep the newest protected results untouched and return a new array
export function pruneToolResults(
  messages: OllamaMessage[],
  protectCount: number = PRUNE_PROTECT_COUNT,
  startIndex = 0
): {
  prunedMessages: OllamaMessage[]
  prunedCount: number
}
{
  // find tool results outside the frozen prefix
  const toolIndices: number[] = []
  for (let i = startIndex; i < messages.length; i++)
  {
    if (messages[i]!.role === 'tool') toolIndices.push(i)
  }

  // protect the newest results by position
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

// remove thinking blocks before sending messages to the summarizer
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

// format messages into the summarizer transcript
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
        // cap long tool results before summarization
        const content = ellipsize(msg.content, 300)
        lines.push(`  [${msg.tool_name ?? 'tool'} result] ${content}`)
        break
      }
    }
  }

  return lines.join('\n')
}

// build the structured handoff for the summarizer
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

// count the system prompt and contiguous frozen summaries on restore
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

// split the live region into messages to summarize and messages to retain
// without changing the frozen prefix
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

  // prefer a user-message boundary so turns stay intact
  const splitTarget = live.length - config.minRecentMessages

  // walk forward to the next user message
  let splitIndex = splitTarget
  while (splitIndex < live.length && live[splitIndex]?.role !== 'user')
  {
    splitIndex++
  }

  // use the target when no user-message boundary exists
  if (splitIndex >= live.length)
  {
    splitIndex = splitTarget
  }

  return {
    toSummarize: live.slice(0, splitIndex),
    toKeep: live.slice(splitIndex),
  }
}

// append a frozen summary while preserving the prefix and retained live tail
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

  // keep the system message only in the frozen prefix
  const recent = toKeep.filter((m) => m.role !== 'system')

  return [...frozenPrefix, summaryMessage, ...recent]
}
