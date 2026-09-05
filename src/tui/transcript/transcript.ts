// src/tui/transcript/transcript.ts
// format conversation blocks into viewport-ready lines with visual hierarchy

import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import { renderUnifiedDiff } from './diff.js'
import { resolveToolResultView, toolResultExpansionKey } from './expansion.js'
import { renderMarkdownToAnsi } from './markdown.js'
import { renderStreamingMarkdown } from './stream-markdown.js'
import {
  hyperlinksRequested,
  prefersReducedMotion,
} from '../shell/terminal-prefs.js'
import { buildFileLink } from '../shell/links.js'
import { formatElapsed } from '../shell/metrics.js'
import { shimmerText } from './shimmer.js'
import { getThemeGeneration, style } from '../theme.js'
import { SOFT_WRAP_OPTIONS, wrapLines } from '../wrap.js'
import type { ToolCallPresentation } from '../../tools/tool.js'
import { ellipsize } from '../../utils/ellipsize.js'
import { stringifyForDisplay } from '../../utils/untrusted-text.js'
import { sanitizeUntrustedText, sanitizeStyledText } from './sanitize.js'
import type { OutputBlock, ToolCallBlock } from './types.js'

// settle every call still owned by a terminal turn so none keeps animating
export function failPendingToolCalls(
  blocks: readonly OutputBlock[],
  startedAt: ReadonlyMap<number, number>,
  finishedAt: number
): OutputBlock[]
{
  return blocks.map((block) =>
  {
    if (block.type !== 'tool_call' || block.status) return block
    if (block.callId === undefined || !startedAt.has(block.callId)) return block
    const started = startedAt.get(block.callId)!
    return {
      ...block,
      status: 'error',
      duration: Math.max(finishedAt - started, 0),
    }
  })
}

// braille spinner frames for in-progress tools
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// cached lines are only valid for the theme generation & expansion state they
// were rendered under; width and expansion share one composite inner key
interface CachedLines
{
  generation: number
  cwd?: string
  lines: string[]
}
const FINALIZED_BLOCK_CACHE = new WeakMap<
  OutputBlock,
  Map<number, CachedLines>
>()

function blockCacheKey(width: number, expansion: number): number
{
  return width * 2 + expansion
}

function getSpinnerFrame(tick: number): string
{
  // reduced motion pins the first frame instead of animating
  if (prefersReducedMotion()) return SPINNER_FRAMES[0]!
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!
}

// prefer the event-time summary; otherwise use compact JSON
export function summarizeToolArgs(
  args: Record<string, unknown>,
  display?: ToolCallPresentation
): string
{
  const summary = display?.summary ?? stringifyForDisplay(args)
  return ellipsize(
    sanitizeUntrustedText(summary).replace(/\s+/g, ' ').trim(),
    60
  )
}

function getCachedBlockLines(
  block: OutputBlock,
  width: number,
  generation: number,
  render: () => string[],
  cwd?: string
): string[]
{
  const key = blockCacheKey(width, toolResultExpansionKey(block))
  const widthCache = FINALIZED_BLOCK_CACHE.get(block)
  const cached = widthCache?.get(key)
  if (cached && cached.generation === generation && cached.cwd === cwd)
  {
    return cached.lines
  }

  const lines = render()
  const nextWidthCache = widthCache ?? new Map<number, CachedLines>()
  nextWidthCache.set(key, { generation, lines, cwd })
  FINALIZED_BLOCK_CACHE.set(block, nextWidthCache)

  return lines
}

// use the event-time label when available; otherwise retain the raw name
function toolDisplayLabel(
  toolName: string,
  display?: ToolCallPresentation
): string
{
  return sanitizeUntrustedText(display?.label ?? toolName)
}

// format an in-progress tool call that depends on the current spinner frame
function formatPendingToolCall(
  block: ToolCallBlock,
  width: number,
  spinnerTick: number,
  cwd?: string
): string[]
{
  const spinner = style('primary')(getSpinnerFrame(spinnerTick))
  const label = toolDisplayLabel(block.toolName, block.display)
  const argDisplay = formatToolArgDisplay(
    block.toolName,
    block.args,
    block.display,
    cwd
  )

  const header = `   ${style('code')('│')} ${spinner} ${style('code')(label)} ${argDisplay}`

  return wrapLines(header, width)
}

// format assistant markdown into the '● Coral' header + wrapped body lines
function formatAssistantText(content: string, width: number): string[]
{
  return [
    '',
    ` ${style('primary').bold('●')} ${style('muted')('Coral')}`,
    ...wrapLines(renderMarkdownToAnsi(content), width - 3, '   '),
  ]
}

// live text: completed paragraphs style progressively while the unterminated
// tail stays plain until it settles (see stream-markdown.ts)
function formatStreamingAssistantText(
  content: string,
  width: number,
  themeGeneration: number
): string[]
{
  return [
    '',
    ` ${style('primary').bold('●')} ${style('muted')('Coral')}`,
    ...renderStreamingMarkdown(content, width, themeGeneration),
  ]
}

// styled tool-arg summary — bash gets a '$ ' prefix, others dimmed
// format a tool call's arg summary; with CORAL_HYPERLINKS=1 a recognized
// path field is wrapped in an OSC 8 link after sanitization (the sanitizer
// would strip the escape sequence, so linking happens last)
function formatToolArgDisplay(
  toolName: string,
  args: Record<string, unknown>,
  display?: ToolCallPresentation,
  cwd?: string
): string
{
  const argSummary = summarizeToolArgs(args, display)
  if (toolName === 'bash')
  {
    return chalk.dim('$ ') + chalk.white(argSummary)
  }

  const linked = maybeLinkifyPathArg(args, argSummary, display, cwd)
  return chalk.dim(linked)
}

const PATH_ARG_FIELDS = ['path', 'file_path', 'notebook_path'] as const

function maybeLinkifyPathArg(
  args: Record<string, unknown>,
  argSummary: string,
  display?: ToolCallPresentation,
  cwd?: string
): string
{
  if (!hyperlinksRequested() || display?.mcp) return argSummary

  for (const field of PATH_ARG_FIELDS)
  {
    const value = args[field]
    if (typeof value !== 'string' || value === '') continue

    const shown = sanitizeUntrustedText(value)
    if (!argSummary.includes(shown)) continue

    return argSummary.replace(
      shown,
      buildFileLink(value, shown, { enabled: true, cwd })
    )
  }
  return argSummary
}

// format a finalized output block into styled terminal lines
function formatFinalizedBlock(
  block: OutputBlock,
  width: number,
  cwd?: string
): string[]
{
  switch (block.type)
  {
    case 'user':
    {
      const contentLines = sanitizeUntrustedText(block.content).split('\n')
      const lines: string[] = []
      lines.push('')
      lines.push(
        ` ${style('user').bold('›')} ${style('user')(contentLines[0] ?? '')}`
      )
      for (let i = 1; i < contentLines.length; i++)
      {
        lines.push(`   ${style('user')(contentLines[i]!)}`)
      }
      return lines
    }

    case 'assistant':
      return formatAssistantText(block.content, width)

    case 'thinking':
    {
      const lines: string[] = []
      const border = style('thinking')('│')
      lines.push('')
      lines.push(`   ${border} ${style('thinking').dim('Thinking')}`)
      const thinkLines = wrapLines(
        chalk.dim(sanitizeUntrustedText(block.content)),
        width - 6,
        ''
      )
      for (const line of thinkLines)
      {
        lines.push(`   ${border} ${line}`)
      }
      return lines
    }

    case 'tool_call':
    {
      const label = toolDisplayLabel(block.toolName, block.display)
      const isError = block.status === 'error'
      const statusMark = isError ? style('error')('✗') : style('success')('✓')
      const duration =
        block.duration != null
          ? chalk.dim(` ${formatElapsed(block.duration)}`)
          : ''
      const border = isError ? style('error')('│') : style('code')('│')
      const argDisplay = formatToolArgDisplay(
        block.toolName,
        block.args,
        block.display,
        cwd
      )

      const header = `   ${border} ${statusMark} ${style('code')(label)} ${argDisplay}${duration}`
      return wrapLines(header, width)
    }

    case 'tool_result':
    {
      // collapse is decided here, not at construction, so ctrl+o reaches the
      // full (bounded) content the block retained
      const view = resolveToolResultView(block)
      if (!view.text) return []
      return formatToolResultLines(view.text, block.isError ?? false, width)
    }

    case 'diff':
    {
      const border = chalk.dim('│')
      const rendered = renderUnifiedDiff(block.unified, Math.max(width - 8, 12))
      return rendered.map((line) => `   ${border}   ${line}`)
    }

    case 'error':
    {
      const lines: string[] = []
      lines.push('')
      lines.push(` ${style('error').bold('✗')} ${style('error')('Error')}`)
      lines.push(
        ...wrapLines(
          style('error')(sanitizeUntrustedText(block.content)),
          width - 3,
          '   '
        )
      )
      return lines
    }

    case 'system':
    {
      const lines: string[] = []
      lines.push('')
      // preserve app-built chalk styling while stripping dangerous controls —
      // system blocks carry styled formatter output (/status, /theme, etc.)
      for (const line of sanitizeStyledText(block.content).split('\n'))
      {
        lines.push(`   ${chalk.dim(line)}`)
      }
      return lines
    }
  }
}

// format a block while caching finalized content by identity, width, and theme
function formatBlock(
  block: OutputBlock,
  width: number,
  spinnerTick: number,
  themeGeneration: number,
  cwd?: string
): string[]
{
  if (block.type === 'tool_call' && !block.status)
  {
    return formatPendingToolCall(block, width, spinnerTick, cwd)
  }

  return getCachedBlockLines(
    block,
    width,
    themeGeneration,
    () => formatFinalizedBlock(block, width, cwd),
    cwd
  )
}

// format tool result output with left-border continuation style
function formatToolResultLines(
  content: string,
  isError: boolean,
  width: number
): string[]
{
  const textStyle = isError ? style('error') : chalk.dim
  const border = isError ? style('error')('│') : chalk.dim('│')
  const maxWidth = Math.max(width - 8, 12)
  const contentLines = sanitizeUntrustedText(content).split('\n')
  const result: string[] = []

  for (const raw of contentLines)
  {
    if (raw.length > maxWidth)
    {
      const wrapped = wrapAnsi(raw, maxWidth, SOFT_WRAP_OPTIONS).split('\n')
      for (const segment of wrapped)
      {
        result.push(`   ${border}   ${textStyle(segment)}`)
      }
    }
    else
    {
      result.push(`   ${border}   ${textStyle(raw)}`)
    }
  }

  return result
}

export interface TranscriptOptions
{
  cwd?: string
  blocks: OutputBlock[]
  streaming: string
  width: number
  spinnerTick?: number
  showWaitingIndicator?: boolean
  waitingElapsed?: number
  streamingThinking?: string
  showThinking?: boolean
  // memoization input: callers re-render when the active theme changes
  themeGeneration?: number
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
    themeGeneration = getThemeGeneration(),
  } = opts
  const transcript: string[] = []

  for (const block of blocks)
  {
    if (!showThinking && block.type === 'thinking')
    {
      continue
    }
    transcript.push(
      ...formatBlock(block, width, spinnerTick, themeGeneration, opts.cwd)
    )
  }

  if (showThinking && streamingThinking)
  {
    transcript.push(
      ...formatBlock(
        { type: 'thinking', content: streamingThinking },
        width,
        spinnerTick,
        themeGeneration
      )
    )
  }
  else if (streamingThinking)
  {
    const border = style('thinking')('│')
    transcript.push('')
    transcript.push(
      `   ${border} ${style('thinking').dim('Thinking')} ${chalk.dim('· ctrl+t to show')}`
    )
  }

  // render streaming assistant text after reasoning
  if (streaming)
  {
    transcript.push(
      ...formatStreamingAssistantText(streaming, width, themeGeneration)
    )
  }
  else if (showWaitingIndicator)
  {
    transcript.push('')
    transcript.push(
      ` ${style('primary').bold('●')} ${shimmerText('thinking...', waitingElapsed)}`
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

export function padLinesTop(lines: string[], height: number): string[]
{
  return [...Array(Math.max(height - lines.length, 0)).fill(''), ...lines]
}

export function centerLinesVertical(lines: string[], height: number): string[]
{
  const topPad = Math.max(Math.floor((height - lines.length) / 2), 0)
  return [...Array(topPad).fill(''), ...lines]
}
