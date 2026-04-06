// src/agent/compaction.ts
// conversation compaction — summarize old turns to stay within context limits

import type { OllamaMessage } from '../ollama/client.js'

// rough token estimate: ~4 chars per token (conservative for English + code)
const CHARS_PER_TOKEN = 4

// default context window size (tokens) — conservative for most local models
const DEFAULT_CONTEXT_WINDOW = 8_192

// reserve this many tokens for the system prompt
const SYSTEM_PROMPT_RESERVE = 2_048

// reserve this many tokens for the model's response
const RESPONSE_RESERVE = 2_048

// minimum messages to keep verbatim (recent context the model needs)
const MIN_RECENT_MESSAGES = 10

// don't compact if total messages are below this count
const MIN_MESSAGES_FOR_COMPACTION = 20

// compaction configuration
export interface CompactionConfig
{
  // model context window size in tokens (default: 8192)
  contextWindow: number
  // minimum recent messages to preserve verbatim
  minRecentMessages: number
  // minimum total messages before compaction triggers
  minMessagesForCompaction: number
}

// default compaction configuration
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  minRecentMessages: MIN_RECENT_MESSAGES,
  minMessagesForCompaction: MIN_MESSAGES_FOR_COMPACTION,
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

// check whether compaction should trigger from a cached token estimate
export function shouldCompactByTotal(
  messageCount: number,
  totalTokens: number,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
): boolean
{
  if (messageCount < config.minMessagesForCompaction) return false

  const budget = config.contextWindow - SYSTEM_PROMPT_RESERVE - RESPONSE_RESERVE
  return totalTokens > budget
}

// check whether compaction should trigger
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

// format messages into a readable summary for the model to compress
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
          msg.content.length > 500
            ? msg.content.slice(0, 497) + '…'
            : msg.content
        lines.push(`  [${msg.tool_name ?? 'tool'} result] ${content}`)
        break
      }
    }
  }

  return lines.join('\n')
}

// build the compaction prompt — asks the model to summarize old conversation
export function buildCompactionPrompt(
  messagesToSummarize: OllamaMessage[]
): string
{
  const formatted = formatMessagesForSummary(messagesToSummarize)

  return `Summarize the following conversation history concisely. Focus on:
- What the user asked for & what was accomplished
- Key decisions made & files modified
- Any important context or constraints mentioned
- Current state of the work (what's done, what's pending)

Keep the summary under 500 words. Write in past tense. Use bullet points for clarity.

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
  // insert summary as a system-level context message right after the system prompt
  const summaryMessage: OllamaMessage = {
    role: 'user',
    content: `[Previous conversation summary — for context only, do not respond to this directly]\n\n${summary}`,
  }

  // add an assistant acknowledgment so the conversation flow is valid
  const ackMessage: OllamaMessage = {
    role: 'assistant',
    content:
      'Understood. I have the context from our previous conversation. How can I help you continue?',
  }

  // filter out system messages from recent (we already have the system prompt)
  const recent = recentMessages.filter((m) => m.role !== 'system')

  return [systemMsg, summaryMessage, ackMessage, ...recent]
}
