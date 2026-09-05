// src/tui/transcript/restored-blocks.ts
// rebuild transcript blocks from saved messages

import type { OllamaMessage } from '../../types/inference.js'
import { capStoredOutput } from '../../utils/truncate-output.js'
import type { OutputBlock } from './types.js'
import { formatMentionNotice } from '../prompt/mentions.js'

export function buildRestoredBlocks(messages: OllamaMessage[]): OutputBlock[]
{
  const restoredBlocks: OutputBlock[] = []

  for (const msg of messages)
  {
    if (msg.role === 'system') continue

    if (msg.role === 'user')
    {
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

      continue
    }

    if (msg.role === 'tool' && msg.content)
    {
      restoredBlocks.push({
        type: 'tool_result',
        toolName: msg.tool_name ?? 'tool',
        // restored blocks keep the persisted (bounded) text; collapse is a
        // render-time decision so ctrl+o reaches everything that survived
        content: capStoredOutput(msg.content).text,
      })
    }
  }

  return restoredBlocks
}
