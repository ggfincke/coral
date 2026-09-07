// tests/tui/expansion.test.ts
// tests for expandable tool-output state & per-kind collapse budgets

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  isNewestToolResultExpanded,
  resolveToolResultView,
  toggleNewestToolResult,
  toolResultBudgetLines,
} from '../../src/tui/transcript/expansion.js'
import type { OutputBlock } from '../../src/tui/transcript/types.js'

function resultBlock(toolName: string, lines: number): OutputBlock
{
  return {
    type: 'tool_result',
    toolName,
    content: Array.from({ length: lines }, (_, i) => `line-${i}`).join('\n'),
  }
}

test('budgets differ per tool kind', () =>
{
  assert.equal(toolResultBudgetLines('bash'), 30)
  assert.equal(toolResultBudgetLines('mcp__fs__read'), 15)
  assert.equal(toolResultBudgetLines('grep'), 30)
})

test('collapsed view truncates at the budget w/ a count suffix', () =>
{
  const block = resultBlock('bash', 45)
  const view = resolveToolResultView(block)

  assert.equal(view.expanded, false)
  assert.equal(view.hiddenLines, 15)
  const text = view.text.split('\n')
  assert.equal(text.length, 31)
  assert.ok(text[30]!.startsWith('… (15 more lines'))
})

test('short results render untouched', () =>
{
  const view = resolveToolResultView(resultBlock('bash', 5))
  assert.equal(view.hiddenLines, 0)
  assert.equal(view.text.split('\n').length, 5)
})

test('toggle flips only the newest tool result & reports its state', () =>
{
  const older = resultBlock('bash', 40)
  const newer = resultBlock('grep', 40)
  const blocks: OutputBlock[] = [
    older,
    { type: 'system', content: 'note' },
    newer,
  ]

  assert.equal(isNewestToolResultExpanded(blocks), false)

  const toggled = toggleNewestToolResult(blocks)
  assert.equal(toggled, newer)
  assert.equal(isNewestToolResultExpanded(blocks), true)
  // the older result is untouched
  assert.equal(resolveToolResultView(older).expanded, false)

  // expanded view passes full content through
  const expanded = resolveToolResultView(newer)
  assert.equal(expanded.expanded, true)
  assert.equal(expanded.text.split('\n').length, 40)

  // second toggle collapses again
  toggleNewestToolResult(blocks)
  assert.equal(isNewestToolResultExpanded(blocks), false)
})

test('toggling w/o any tool results returns null', () =>
{
  assert.equal(toggleNewestToolResult([{ type: 'system', content: 'x' }]), null)
})
