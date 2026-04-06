// src/tui/transcript.ts
// format conversation blocks into viewport-ready lines w/ visual hierarchy

import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import { renderMarkdownToAnsi } from './markdown.js'
import { shimmerText } from './shimmer.js'
import { coralBold, coral, ocean, oceanBold, sand } from './theme.js'
import { wrapLines } from './wrap.js'

// block types w/ richer data for tool calls & results

export interface UserBlock
{
  type: 'user'
  content: string
}

export interface AssistantBlock
{
  type: 'assistant'
  content: string
}

export interface ThinkingBlock
{
  type: 'thinking'
  content: string
}

// emitted when a tool call starts (before execution)
export interface ToolCallBlock
{
  type: 'tool_call'
  toolName: string
  args: Record<string, unknown>
  // set when the tool finishes
  status?: 'success' | 'error'
  duration?: number
}

// emitted when tool execution completes
export interface ToolResultBlock
{
  type: 'tool_result'
  toolName: string
  content: string
  isError?: boolean
}

export interface ErrorBlock
{
  type: 'error'
  content: string
}

export type OutputBlock =
  | UserBlock
  | AssistantBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | ErrorBlock

// braille spinner frames for in-progress tools
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FINALIZED_BLOCK_CACHE = new WeakMap<OutputBlock, Map<number, string[]>>()

export function getSpinnerFrame(tick: number): string
{
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!
}

// format tool call args into a short summary
export function summarizeToolArgs(
  toolName: string,
  args: Record<string, unknown>
): string
{
  if (toolName === 'bash') return String(args.command ?? '')
  if (toolName === 'read_file') return String(args.path ?? '')
  if (toolName === 'write_file') return String(args.path ?? '')
  if (toolName === 'edit_file') return String(args.path ?? '')
  if (toolName === 'grep')
  {
    const pattern = String(args.pattern ?? '')
    const path = args.path ? ` ${args.path}` : ''
    return `${pattern}${path}`
  }
  if (toolName === 'glob') return String(args.pattern ?? '')
  if (toolName === 'list_files') return String(args.path ?? '.')
  // fallback: compact JSON
  const json = JSON.stringify(args)
  return json.length > 60 ? `${json.slice(0, 57)}...` : json
}

function getCachedBlockLines(
  block: OutputBlock,
  width: number,
  render: () => string[]
): string[]
{
  const widthCache = FINALIZED_BLOCK_CACHE.get(block)
  if (widthCache?.has(width))
  {
    return widthCache.get(width)!
  }

  const lines = render()
  const nextWidthCache = widthCache ?? new Map<number, string[]>()
  nextWidthCache.set(width, lines)
  FINALIZED_BLOCK_CACHE.set(block, nextWidthCache)

  return lines
}

// format an in-progress tool call that depends on the current spinner frame
function formatPendingToolCall(
  block: ToolCallBlock,
  width: number,
  spinnerTick: number
): string[]
{
  const spinner = coral(getSpinnerFrame(spinnerTick))
  const header =
    `   ${chalk.dim('⎿')} ${spinner} ${chalk.dim(block.toolName)} ` +
    chalk.dim(summarizeToolArgs(block.toolName, block.args))

  return wrapLines(header, width)
}

// format a finalized output block into styled terminal lines
function formatFinalizedBlock(block: OutputBlock, width: number): string[]
{
  if (block.type === 'tool_call' && !block.status)
  {
    return formatPendingToolCall(block, width, 0)
  }

  switch (block.type)
  {
    case 'user':
    {
      const contentLines = block.content.split('\n')
      const lines: string[] = []
      lines.push('')
      lines.push(` ${oceanBold('›')} ${ocean(contentLines[0] ?? '')}`)
      for (let i = 1; i < contentLines.length; i++)
      {
        lines.push(`   ${ocean(contentLines[i]!)}`)
      }
      return lines
    }

    case 'assistant':
    {
      const lines: string[] = []
      lines.push('')
      lines.push(` ${coralBold('●')} ${sand('Coral')}`)
      lines.push(...wrapLines(renderMarkdownToAnsi(block.content), width - 3, '   '))
      return lines
    }

    case 'thinking':
    {
      const lines: string[] = []
      lines.push('')
      lines.push(` ${chalk.bold.magenta('◌')} ${sand('Thinking')}`)
      lines.push(...wrapLines(chalk.dim(block.content), width - 3, '   '))
      return lines
    }

    case 'tool_call':
    {
      const argSummary = summarizeToolArgs(block.toolName, block.args)
      const statusMark =
        block.status === 'success' ? chalk.green('✓') : chalk.red('✗')
      const duration =
        block.duration != null
          ? ` ${chalk.dim(`${(block.duration / 1000).toFixed(1)}s`)}`
          : ''
      const header =
        `   ${chalk.dim('⎿')} ${chalk.dim(block.toolName)} ${argSummary} ` +
        `${statusMark}${duration}`
      return wrapLines(header, width)
    }

    case 'tool_result':
    {
      if (!block.content) return []
      return formatToolResultLines(block.content, block.isError ?? false, width)
    }

    case 'error':
    {
      const lines: string[] = []
      lines.push('')
      lines.push(` ${chalk.bold.red('✗')} ${chalk.red('Error')}`)
      lines.push(...wrapLines(chalk.red(block.content), width - 3, '   '))
      return lines
    }
  }
}

// format a block while caching finalized content by block identity & width
function formatBlock(
  block: OutputBlock,
  width: number,
  spinnerTick: number
): string[]
{
  if (block.type === 'tool_call' && !block.status)
  {
    return formatPendingToolCall(block, width, spinnerTick)
  }

  return getCachedBlockLines(block, width, () =>
    formatFinalizedBlock(block, width)
  )
}

// format tool result output w/ └ tree connector on first line
function formatToolResultLines(
  content: string,
  isError: boolean,
  width: number
): string[]
{
  const style = isError ? chalk.red : chalk.dim
  const maxWidth = Math.max(width - 8, 12)
  const contentLines = content.split('\n')
  const result: string[] = []

  for (let i = 0; i < contentLines.length; i++)
  {
    const raw = contentLines[i] ?? ''
    const prefix = i === 0 ? `     ${chalk.dim('└')} ` : '       '

    // wrap long lines
    if (raw.length > maxWidth)
    {
      const wrapped = wrapAnsi(raw, maxWidth, {
        hard: false,
        trim: false,
        wordWrap: true,
      }).split('\n')
      for (let j = 0; j < wrapped.length; j++)
      {
        if (i === 0 && j === 0)
        {
          result.push(`     ${chalk.dim('└')} ${style(wrapped[j])}`)
        }
        else
        {
          result.push(`       ${style(wrapped[j])}`)
        }
      }
    }
    else
    {
      result.push(`${prefix}${style(raw)}`)
    }
  }

  return result
}

export interface TranscriptOptions
{
  blocks: OutputBlock[]
  streaming: string
  width: number
  spinnerTick?: number
  showWaitingIndicator?: boolean
  waitingElapsed?: number
  streamingThinking?: string
  showThinking?: boolean
}

export function buildTranscriptLines(opts: TranscriptOptions): string[]
{
  const {
    blocks,
    streaming,
    width,
    spinnerTick = 0,
    showWaitingIndicator = false,
    waitingElapsed = 0,
    streamingThinking = '',
    showThinking = true,
  } = opts
  const transcript: string[] = []

  for (const block of blocks)
  {
    if (!showThinking && block.type === 'thinking')
    {
      continue
    }
    transcript.push(...formatBlock(block, width, spinnerTick))
  }

  if (showThinking && streamingThinking)
  {
    transcript.push(
      ...formatBlock(
        { type: 'thinking', content: streamingThinking },
        width,
        spinnerTick
      )
    )
  }
  else if (streamingThinking)
  {
    transcript.push('')
    transcript.push(
      ` ${chalk.bold.magenta('◌')} ${sand('Thinking hidden · ctrl+t to show')}`
    )
  }

  // render streaming assistant text after reasoning
  if (streaming)
  {
    transcript.push('')
    transcript.push(` ${coralBold('●')} ${sand('Coral')}`)
    transcript.push(
      ...wrapLines(renderMarkdownToAnsi(streaming), width - 3, '   ')
    )
  }
  else if (showWaitingIndicator)
  {
    transcript.push('')
    transcript.push(
      ` ${coralBold('●')} ${shimmerText('thinking...', waitingElapsed)}`
    )
  }

  return transcript
}

export function maxScrollOffset(
  totalLines: number,
  viewportHeight: number
): number
{
  return Math.max(totalLines - viewportHeight, 0)
}

export function sliceViewport(
  lines: string[],
  viewportHeight: number,
  scrollOffset: number
): string[]
{
  const clampedOffset = Math.min(
    scrollOffset,
    maxScrollOffset(lines.length, viewportHeight)
  )
  const end = Math.max(lines.length - clampedOffset, 0)
  const start = Math.max(end - viewportHeight, 0)
  return lines.slice(start, end)
}
