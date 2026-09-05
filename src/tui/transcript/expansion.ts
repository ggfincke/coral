// src/tui/transcript/expansion.ts
// expandable tool-output state & per-kind collapse budgets

import type { OutputBlock } from './types.js'

// default collapsed view: bash keeps its historical 30 lines, MCP results
// stay tighter since their payloads are rarely line-oriented
const BASH_BUDGET_LINES = 30
const DEFAULT_BUDGET_LINES = 30
const MCP_BUDGET_LINES = 15

export function toolResultBudgetLines(toolName: string): number
{
  if (toolName.startsWith('mcp__')) return MCP_BUDGET_LINES
  if (toolName === 'bash') return BASH_BUDGET_LINES
  return DEFAULT_BUDGET_LINES
}

export function isExpandableBlock(block: OutputBlock): boolean
{
  return block.type === 'tool_result'
}

// expansion lives in a WeakMap keyed by block identity: indices shift on
// every rebuild so identity-keying is the only stable handle; blocks are
// TUI-only values that never persist, and restored sessions start collapsed
const EXPANDED_RESULTS = new WeakMap<OutputBlock, true>()

// flip the newest expandable block's expansion state; returns it or null when
// the transcript has no tool results yet
export function toggleNewestToolResult(
  blocks: readonly OutputBlock[]
): OutputBlock | null
{
  for (let i = blocks.length - 1; i >= 0; i--)
  {
    const block = blocks[i]
    if (block && isExpandableBlock(block))
    {
      if (EXPANDED_RESULTS.has(block))
      {
        EXPANDED_RESULTS.delete(block)
      }
      else
      {
        EXPANDED_RESULTS.set(block, true)
      }
      return block
    }
  }

  return null
}

export function isNewestToolResultExpanded(
  blocks: readonly OutputBlock[]
): boolean
{
  for (let i = blocks.length - 1; i >= 0; i--)
  {
    const block = blocks[i]
    if (block && isExpandableBlock(block))
    {
      return EXPANDED_RESULTS.has(block)
    }
  }

  return false
}

// internal read used by the formatter; 0 = collapsed/non-tool blocks so the
// line cache key only varies when expansion actually changes rendering
export function toolResultExpansionKey(block: OutputBlock): 0 | 1
{
  return block.type === 'tool_result' && EXPANDED_RESULTS.has(block) ? 1 : 0
}

export interface CollapsedResultView
{
  text: string
  // hidden line count when collapsed (0 = nothing was cut)
  hiddenLines: number
  expanded: boolean
}

// render-time truncation for one tool result: collapsed views apply the
// per-kind budget w/ a count-carrying suffix; expanded views pass through
export function resolveToolResultView(block: OutputBlock): CollapsedResultView
{
  if (block.type !== 'tool_result')
  {
    return { text: '', hiddenLines: 0, expanded: false }
  }

  const expanded = toolResultExpansionKey(block) === 1
  if (expanded) return { text: block.content, hiddenLines: 0, expanded: true }

  const budget = toolResultBudgetLines(block.toolName)
  const lines = block.content.split('\n')
  const total = lines.length
  if (total <= budget)
  {
    return { text: block.content, hiddenLines: 0, expanded: false }
  }

  const shown = lines.slice(0, budget).join('\n')
  return {
    text: `${shown}\n… (${total - budget} more lines · ctrl+o expands)`,
    hiddenLines: total - budget,
    expanded: false,
  }
}
