// src/tui/shell/copy.ts
// extract the last assistant reply and its last code block for /copy

import { lexer, type Token, type Tokens } from 'marked'
import type { OllamaMessage } from '../../types/inference.js'
import { sanitizeUntrustedText } from '../../utils/untrusted-text.js'

// find the last assistant message with non-empty text; the clipboard gets
// the same control-free text the transcript showed, so nothing hidden pastes
export function lastAssistantText(messages: OllamaMessage[]): string | null
{
  for (let i = messages.length - 1; i >= 0; i--)
  {
    const msg = messages[i]
    if (msg?.role !== 'assistant') continue
    const content = sanitizeUntrustedText(msg.content ?? '').trim()
    if (content) return content
  }
  return null
}

// last fenced code block in document order, recursing into nested tokens so
// blocks inside lists/quotes still count; null when there are none
export function lastCodeBlock(markdown: string): string | null
{
  let last: string | null = null

  const visit = (tokens: Token[]): void =>
  {
    for (const token of tokens)
    {
      if (token.type === 'code')
      {
        last = (token as { text: string }).text
      }
      if (token.type === 'list')
      {
        for (const item of (token as Tokens.List).items) visit(item.tokens)
      }
      const nested = (token as { tokens?: Token[] }).tokens
      if (nested) visit(nested)
    }
  }

  visit(lexer(markdown))
  return last
}
