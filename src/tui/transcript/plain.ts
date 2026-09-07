// src/tui/transcript/plain.ts
// plain-text block lines shared by export, raw mode, & expanded views

import type { OutputBlock } from './types.js'
import { sanitizeUntrustedText } from './sanitize.js'

const TOOL_ARGS_BUDGET = 200

// one block -> plain text lines; nothing here may emit escape sequences so
// terminal-native selection & markdown export stay clean
function blockLines(block: OutputBlock): string[]
{
  switch (block.type)
  {
    case 'user':
      return [`> ${block.content}`]
    case 'assistant':
      return block.content.split('\n')
    case 'thinking':
      return ['[thinking]', ...block.content.split('\n')]
    case 'tool_call':
    {
      let args = JSON.stringify(block.args)
      if (args.length > TOOL_ARGS_BUDGET)
      {
        args = `${args.slice(0, TOOL_ARGS_BUDGET - 1)}…`
      }
      const suffix =
        block.status === 'error'
          ? ' (error)'
          : typeof block.duration === 'number'
            ? ` (${Math.round(block.duration)}ms)`
            : ''
      return [`[tool] ${block.toolName} ${args}${suffix}`]
    }
    case 'tool_result':
      return [
        `[result] ${block.toolName}`,
        ...block.content.split('\n').map((line) => `  ${line}`),
      ]
    case 'diff':
      return block.unified.split('\n')
    case 'error':
      return ['[error]', ...block.content.split('\n')]
    case 'system':
      return [block.content]
  }
}

export function formatBlockPlain(block: OutputBlock): string[]
{
  return blockLines(block).map(sanitizeUntrustedText)
}

// whole transcript as selectable plain text
export function formatBlocksPlain(blocks: readonly OutputBlock[]): string[]
{
  const lines: string[] = []
  for (const block of blocks)
  {
    lines.push(...formatBlockPlain(block))
  }
  return lines
}
