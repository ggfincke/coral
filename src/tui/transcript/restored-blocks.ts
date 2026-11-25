// src/tui/transcript/restored-blocks.ts
// rebuild transcript blocks from saved messages

import { FROZEN_SUMMARY_MARKER } from '../../agent/state/compaction.js'
import type { OllamaMessage } from '../../types/inference.js'
import { parseStoredToolResult } from '../../types/tool-result.js'
import { findUserTurnStarts, type UndoTurn } from '../../types/undo.js'
import { capStoredOutput } from '../../utils/truncate-output.js'
import type { OutputBlock, ToolCallBlock } from './types.js'
import { formatMentionNotice } from '../prompt/mentions.js'

// the live transcript shows a compaction as a notice, never the handoff text
const COMPACTED_CONTEXT_NOTICE = 'Earlier context compacted into a summary'

// compaction handoffs live only in the leading frozen prefix, so a typed
// prompt that happens to start w/ the marker later on stays a prompt
export function findCompactionHandoffs(
  messages: readonly OllamaMessage[]
): Set<number>
{
  const handoffs = new Set<number>()
  for (const [index, message] of messages.entries())
  {
    if (message.role === 'system') continue
    if (
      message.role !== 'user' ||
      !message.content.startsWith(FROZEN_SUMMARY_MARKER)
    )
      break
    handoffs.add(index)
  }
  return handoffs
}

// undo provenance hides internal corrective prompts the live view never
// showed; turns older than the undo window keep the role-based view
export function buildRestoredBlocks(
  messages: readonly OllamaMessage[],
  undo: readonly UndoTurn[] = []
): OutputBlock[]
{
  const restoredBlocks: OutputBlock[] = []
  const turnStarts = new Set(findUserTurnStarts(messages, undo))
  const handoffs = findCompactionHandoffs(messages)
  // tool results pair w/ the preceding assistant's calls by position
  let pendingCalls: ToolCallBlock[] = []

  for (const [index, msg] of messages.entries())
  {
    if (msg.role === 'system') continue

    if (msg.role === 'user')
    {
      if (handoffs.has(index))
      {
        restoredBlocks.push({
          type: 'system',
          content: COMPACTED_CONTEXT_NOTICE,
        })
        continue
      }
      if (!turnStarts.has(index)) continue

      restoredBlocks.push({
        type: 'user',
        content: msg.displayContent ?? msg.content,
      })
      if (msg.attachmentReport)
      {
        const notice = formatMentionNotice(msg.attachmentReport)
        if (notice)
        {
          restoredBlocks.push({ type: 'system', content: notice })
        }
      }
      continue
    }

    if (msg.role === 'assistant')
    {
      if (msg.thinking)
      {
        restoredBlocks.push({ type: 'thinking', content: msg.thinking })
      }

      if (msg.content)
      {
        restoredBlocks.push({ type: 'assistant', content: msg.content })
      }

      pendingCalls = []
      for (const call of msg.tool_calls ?? [])
      {
        const block: ToolCallBlock = {
          type: 'tool_call',
          toolName: call.function.name,
          args: call.function.arguments,
          status: 'recorded',
        }
        restoredBlocks.push(block)
        pendingCalls.push(block)
      }
      continue
    }

    const call = pendingCalls.shift()
    if (msg.role === 'tool' && msg.content)
    {
      const stored = parseStoredToolResult(msg.content)
      if (stored.isError && call) call.status = 'error'
      restoredBlocks.push({
        type: 'tool_result',
        toolName: msg.tool_name ?? 'tool',
        // restored blocks keep the persisted (bounded) text; collapse is a
        // render-time decision so ctrl+o reaches everything that survived
        content: capStoredOutput(stored.text).text,
        ...(stored.isError ? { isError: true } : {}),
      })
    }
  }

  return restoredBlocks
}
