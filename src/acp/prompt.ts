// src/acp/prompt.ts
// normalize baseline ACP prompt content into one Coral turn

import type { ContentBlock } from '@agentclientprotocol/sdk/unstable'
import { sanitizeUntrustedText } from '../utils/untrusted-text.js'
import { invalidAcpParams } from './errors.js'

const MAX_PROMPT_BYTES = 1_048_576

// keep a client-supplied link field on one line inside its reference
function linkText(value: string): string
{
  return sanitizeUntrustedText(value).replace(/\s+/g, ' ').trim()
}

// text and resource_link are the protocol baseline; a link becomes a plain
// reference the model can open with its own tools, never a fetch
export function normalizeAcpPrompt(blocks: readonly ContentBlock[]): string
{
  const parts = blocks.map((block) =>
  {
    if (block.type === 'text') return block.text
    if (block.type === 'resource_link')
      return `[Referenced resource: ${linkText(block.name)} (${linkText(block.uri)})]`
    throw invalidAcpParams(
      `Unsupported prompt content type: ${block.type}; Coral supports text and resource_link only`
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
