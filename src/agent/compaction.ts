// src/agent/compaction.ts
// two-layer conversation compaction — prune tool results first, then summarize

import type { OllamaMessage } from '../types/inference.js'

// rough token estimate: ~4 chars per token (conservative for English + code)
const CHARS_PER_TOKEN = 4

// default context window size (tokens) — conservative floor for the model lineup
const DEFAULT_CONTEXT_WINDOW = 32_768

// prune old tool results when estimated tokens exceed this fraction of context
export const PRUNE_THRESHOLD = 0.75

// trigger full summarization when estimated tokens exceed this fraction of context
export const SUMMARIZE_THRESHOLD = 0.9

// keep this many recent tool results untouched during pruning
export const PRUNE_PROTECT_COUNT = 6

// stop retrying summarization after this many consecutive failures
export const MAX_COMPACT_FAILURES = 2

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

// check whether summarization should trigger
export function shouldCompact(
  messages: OllamaMessage[],
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
): boolean
{
  return shouldCompactByTotal(
    messages.length,
    estimateTotalTokens(messages),
    config
  )
}

// build a prune marker for a tool result being replaced
export function buildPruneMarker(msg: OllamaMessage): string
{
  const toolName = msg.tool_name ?? 'tool'
  const tokens = estimateMessageTokens(msg)

  // take the first 60 chars of content as a preview
  const preview =
    msg.content.length > 60 ? msg.content.slice(0, 57) + '…' : msg.content

  return `[tool result pruned — ${toolName}: ${preview}, ~${tokens} tokens]`
}

// prune old tool results, replacing them w/ compact markers
// keeps the last `protectCount` tool-role messages untouched
// returns a new array — does NOT mutate the input
export function pruneToolResults(
  messages: OllamaMessage[],
  protectCount: number = PRUNE_PROTECT_COUNT
): {
  prunedMessages: OllamaMessage[]
  prunedCount: number
  tokensSaved: number
}
{
  // find all tool-role message indices
  const toolIndices: number[] = []
  for (let i = 0; i < messages.length; i++)
  {
    if (messages[i]!.role === 'tool') toolIndices.push(i)
  }

  // determine which indices are protected (the last N by position)
  const protectedSet = new Set(
    protectCount > 0 ? toolIndices.slice(-protectCount) : []
  )

  let prunedCount = 0
  let tokensSaved = 0
  const prunedMessages: OllamaMessage[] = []

  for (let i = 0; i < messages.length; i++)
  {
    const msg = messages[i]!

    if (msg.role === 'tool' && !protectedSet.has(i))
    {
      const marker = buildPruneMarker(msg)
      const originalTokens = estimateMessageTokens(msg)
      const prunedMsg: OllamaMessage = {
        role: 'tool',
        content: marker,
        tool_name: msg.tool_name,
      }
      const markerTokens = estimateMessageTokens(prunedMsg)

      prunedMessages.push(prunedMsg)
      prunedCount++
      tokensSaved += originalTokens - markerTokens
    }
    else
    {
      prunedMessages.push(msg)
    }
  }

  return { prunedMessages, prunedCount, tokensSaved }
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
        const content =
          msg.content.length > 300
            ? msg.content.slice(0, 297) + '…'
            : msg.content
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

// split messages into "old" (to summarize) & "recent" (to keep verbatim)
// always preserves system prompt at index 0
export function splitForCompaction(
  messages: OllamaMessage[],
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
): { toSummarize: OllamaMessage[]; toKeep: OllamaMessage[] }
{
  // system prompt is always first & always kept
  const systemMsg = messages[0]
  const rest = messages.slice(1)

  if (rest.length <= config.minRecentMessages)
  {
    return { toSummarize: [], toKeep: messages }
  }

  // find a clean split point — try to split at a user message boundary
  // so we don't break mid-turn (assistant + tool calls + tool results)
  const splitTarget = rest.length - config.minRecentMessages

  // walk forward from the target to find a user message (start of a turn)
  let splitIndex = splitTarget
  while (splitIndex < rest.length && rest[splitIndex]?.role !== 'user')
  {
    splitIndex++
  }

  // if we couldn't find a user message boundary, fall back to the target
  if (splitIndex >= rest.length)
  {
    splitIndex = splitTarget
  }

  const toSummarize = rest.slice(0, splitIndex)
  const toKeep = [systemMsg!, ...rest.slice(splitIndex)]

  return { toSummarize, toKeep }
}

// create the compacted message array — replaces old messages w/ a summary
export function buildCompactedMessages(
  systemMsg: OllamaMessage,
  summary: string,
  recentMessages: OllamaMessage[]
): OllamaMessage[]
{
  // insert summary as a handoff context message right after the system prompt
  const summaryMessage: OllamaMessage = {
    role: 'user',
    content: `[Conversation handoff — you are continuing a prior session. Use this context to inform your work, but do not respond to it directly.]\n\n${summary}`,
  }

  // filter out system messages from recent (we already have the system prompt)
  const recent = recentMessages.filter((m) => m.role !== 'system')

  return [systemMsg, summaryMessage, ...recent]
}
