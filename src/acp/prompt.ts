// src/acp/prompt.ts
// normalize baseline ACP prompt content into one Coral turn

import type { ContentBlock } from '@agentclientprotocol/sdk'
import { invalidAcpParams } from './errors.js'

const MAX_PROMPT_BYTES = 1_048_576

export function normalizeAcpPrompt(blocks: readonly ContentBlock[]): string
{
  const parts = blocks.map((block) =>
  {
    if (block.type === 'text') return block.text
    throw invalidAcpParams(
      `Unsupported prompt content type: ${block.type}; Coral supports text only`
    )
  })
  const prompt = parts.join('\n\n')

  if (!prompt.trim())
  {
    throw invalidAcpParams('Prompt content must not be empty')
  }
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES)
  {
    throw invalidAcpParams(
      `Prompt content exceeds the ${MAX_PROMPT_BYTES}-byte limit`
    )
  }
  return prompt
}
