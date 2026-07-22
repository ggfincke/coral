// src/tui/run/approval-box.ts
// bordered tool and MCP launch approval content with bounded viewport rendering

import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import type { McpLaunchApprovalRequest } from '../../mcp/types.js'
import type { ToolCallPresentation } from '../../tools/tool.js'
import { ellipsize, trimTrailingHighSurrogate } from '../../utils/ellipsize.js'
import { renderUnifiedDiff } from '../transcript/diff.js'
import { summarizeToolArgs } from '../transcript/transcript.js'
import { boxFrame } from './status-line.js'
import { style } from '../theme.js'
import { sanitizeUntrustedText } from '../transcript/sanitize.js'
import { stringifyForDisplay } from '../../utils/untrusted-text.js'
import { visibleWidth } from '../wrap.js'

// cap change previews so large edits don't swallow the screen
const MAX_PREVIEW_LINES = 20
const MAX_MCP_APPROVAL_ARG_CHARS = 8_000
const MAX_APPROVAL_TOOL_NAME_CHARS = 256

// logical prompt content: title and actions stay pinned while the body scrolls
export interface PromptBoxContent
{
  label: string
  titleLines: string[]
  bodyLines: string[]
  actionLine: string
}

interface ContentBuilder
{
  innerWidth: number
  warn: (text: string) => string
  title: (content: string) => void
  push: (content: string, decorate?: (line: string) => string) => void
  raw: (line: string) => void
  blank: () => void
  finish: (actionLine: string) => PromptBoxContent
}

function contentBuilder(width: number, label: string): ContentBuilder
{
  const warn = style('warning')
  const innerWidth = Math.max(width - 4, 12)
  const titleLines: string[] = []
  const bodyLines: string[] = []

  const appendInto = (
    target: string[],
    content: string,
    decorate: (line: string) => string = (line) => line
  ) =>
  {
    for (const line of content.split('\n'))
    {
      target.push(decorate(line))
    }
  }

  return {
    innerWidth,
    warn,
    title: (content) => appendInto(titleLines, content, warn),
    push: (content, decorate) => appendInto(bodyLines, content, decorate),
    raw: (line) => bodyLines.push(line),
    blank: () => bodyLines.push(''),
    finish: (actionLine) => ({ label, titleLines, bodyLines, actionLine }),
  }
}

function formatApprovalArgs(
  toolName: string,
  args: Record<string, unknown>,
  presentation?: ToolCallPresentation
): string
{
  // preserve the manager's dynamic-tool decision; do not infer it from a name
  // prefix
  if (presentation?.mcp)
  {
    const json = sanitizeUntrustedText(stringifyForDisplay(args, 2))
    if (json.length <= MAX_MCP_APPROVAL_ARG_CHARS) return json
    return `${trimTrailingHighSurrogate(json.slice(0, MAX_MCP_APPROVAL_ARG_CHARS))}\n… [MCP arguments truncated]`
  }
  const summary =
    presentation?.summary !== undefined
      ? sanitizeUntrustedText(presentation.summary)
      : summarizeToolArgs(args, presentation)
  return toolName === 'bash' ? `$ ${summary}` : summary
}

// lines come back fully styled; render without an outer Ink color prop so the
// embedded diff colors survive
export function buildApprovalContent(
  toolName: string,
  args: Record<string, unknown>,
  width: number,
  diff?: string,
  previewMessage?: string,
  presentation?: ToolCallPresentation
): PromptBoxContent
{
  const box = contentBuilder(width, 'tool approval')

  const cleanToolName = ellipsize(
    sanitizeUntrustedText(toolName).replace(/\s+/g, ' ').trim(),
    MAX_APPROVAL_TOOL_NAME_CHARS
  )
  box.title(`Allow ${cleanToolName}?`)
  box.push(formatApprovalArgs(toolName, args, presentation), box.warn)

  if (diff)
  {
    box.blank()
    const rendered = renderUnifiedDiff(diff, box.innerWidth)
    for (const diffLine of rendered.slice(0, MAX_PREVIEW_LINES))
    {
      box.raw(diffLine)
    }
    if (rendered.length > MAX_PREVIEW_LINES)
    {
      box.raw(chalk.dim(`… +${rendered.length - MAX_PREVIEW_LINES} more lines`))
    }
  }
  else if (previewMessage)
  {
    box.blank()
    box.push(chalk.dim(sanitizeUntrustedText(previewMessage)))
  }

  return box.finish(box.warn('(y) approve  (n) reject  (esc) cancel'))
}

function cleanLaunchValue(value: string): string
{
  return sanitizeUntrustedText(value)
}

function formatLaunchList(values: string[]): string
{
  if (values.length === 0) return '(none)'
  return values.map((value) => cleanLaunchValue(value)).join(', ')
}

// show the complete launch identity before persisting trust
export function buildMcpApprovalContent(
  request: McpLaunchApprovalRequest,
  width: number
): PromptBoxContent
{
  const box = contentBuilder(width, 'MCP launch trust')
  const alias = cleanLaunchValue(request.alias)

  box.title(`Trust & launch MCP server "${alias}"?`)
  box.blank()
  box.push(`Configured command: ${cleanLaunchValue(request.command)}`)
  box.push(`Resolved executable: ${cleanLaunchValue(request.executable)}`)
  box.push(`Arguments: ${cleanLaunchValue(JSON.stringify(request.args))}`)
  box.push(`Working directory: ${cleanLaunchValue(request.launchCwd)}`)
  box.push(`Forwarded environment names: ${formatLaunchList(request.passEnv)}`)
  box.push(`Enabled tools: ${formatLaunchList(request.enabledTools)}`)
  box.push(`Yolo-eligible tools: ${formatLaunchList(request.yoloTools)}`)
  box.push(`Fingerprint: ${cleanLaunchValue(request.fingerprint)}`)
  box.blank()
  box.push(
    'This process is not sandboxed & may access the host, filesystem, or network.',
    box.warn
  )
  if (request.yoloTools.length > 0)
  {
    box.push(
      'Non-denied yolo tools may run without per-call approval in yolo mode.',
      box.warn
    )
  }

  return box.finish(box.warn('(y) trust & launch  (n) reject  (esc) cancel'))
}

// bordered yes/no prompt reused for the doom-loop pause
export function buildConfirmContent(
  message: string,
  width: number,
  label = 'confirm'
): PromptBoxContent
{
  const box = contentBuilder(width, label)
  box.push(sanitizeUntrustedText(message), box.warn)
  return box.finish(box.warn('(y) continue  (n) stop'))
}

export interface PromptBoxRender
{
  lines: string[]
  // highest valid scroll offset for the current geometry
  maxOffset: number
  // body rows shown per page — the page-key scroll step
  pageSize: number
}

interface WrappedPromptBoxContent
{
  titleLines: string[]
  bodyLines: string[]
  actionLines: string[]
}

const wrappedContentCache = new WeakMap<
  PromptBoxContent,
  Map<number, WrappedPromptBoxContent>
>()

// scroll changes only the viewport slice, so retain wrapping for this content
function wrappedPromptContent(
  content: PromptBoxContent,
  width: number
): WrappedPromptBoxContent
{
  let byWidth = wrappedContentCache.get(content)
  if (!byWidth)
  {
    byWidth = new Map()
    wrappedContentCache.set(content, byWidth)
  }
  const cached = byWidth.get(width)
  if (cached) return cached

  const wrap = (line: string): string[] =>
    wrapAnsi(line, width, {
      hard: true,
      trim: false,
      wordWrap: true,
    }).split('\n')
  const wrapped = {
    titleLines: content.titleLines.flatMap(wrap),
    bodyLines: content.bodyLines.flatMap(wrap),
    actionLines: wrap(content.actionLine),
  }
  byWidth.set(width, wrapped)
  return wrapped
}

// frame content into at most maxRows terminal rows; title and actions stay
// pinned while the body scrolls behind a position indicator
export function renderPromptBox(
  content: PromptBoxContent,
  width: number,
  maxRows: number,
  scrollOffset: number
): PromptBoxRender
{
  const warn = style('warning')
  const frame = boxFrame(width, content.label, warn)
  const rowLimit = Math.max(Math.floor(maxRows), 0)
  if (rowLimit === 0) return { lines: [], maxOffset: 0, pageSize: 1 }

  const { titleLines, bodyLines, actionLines } = wrappedPromptContent(
    content,
    frame.innerWidth
  )

  // retain the roomy presentation when every row fits
  const roomyRows =
    2 + 3 + titleLines.length + bodyLines.length + actionLines.length
  if (roomyRows <= rowLimit)
  {
    const lines = [
      frame.top,
      frame.row(''),
      ...titleLines.map(frame.row),
      ...bodyLines.map(frame.row),
      frame.row(''),
      ...actionLines.map(frame.row),
      frame.row(''),
      frame.bottom,
    ]
    return {
      lines: lines.slice(0, rowLimit),
      maxOffset: 0,
      pageSize: Math.max(bodyLines.length, 1),
    }
  }

  // constrained mode drops decorative blanks and moves title overflow into the
  // scrollable body so complete identities remain reachable
  const insideRows = Math.max(rowLimit - 2, 0)
  const visibleActions = actionLines.slice(0, insideRows)
  const contentRows = Math.max(insideRows - visibleActions.length, 0)
  const indicatorRows = contentRows >= 2 ? 1 : 0
  const viewportRows = Math.max(contentRows - indicatorRows, 0)
  const reserveBody = bodyLines.length > 0 && viewportRows > 1 ? 1 : 0
  const pinnedTitleCount = Math.min(
    titleLines.length,
    Math.max(viewportRows - reserveBody, 0)
  )
  const pinnedTitle = titleLines.slice(0, pinnedTitleCount)
  const scrollable = [...titleLines.slice(pinnedTitleCount), ...bodyLines]
  const bodyRows = Math.max(viewportRows - pinnedTitle.length, 0)
  const maxOffset = Math.max(scrollable.length - bodyRows, 0)
  const offset = Math.min(Math.max(scrollOffset, 0), maxOffset)
  const visibleBody = scrollable.slice(offset, offset + bodyRows)
  const pageSize = Math.max(bodyRows, 1)

  let indicator: string | null = null
  if (indicatorRows > 0 && maxOffset > 0)
  {
    const start = offset + 1
    const end = offset + visibleBody.length
    const detailed = `lines ${start}-${end} of ${scrollable.length} · ↑/↓ · PgUp/PgDn`
    const compact = `${start}-${end}/${scrollable.length}`
    indicator = chalk.dim(
      visibleWidth(detailed) <= frame.innerWidth ? detailed : compact
    )
  }

  const lines = [
    frame.top,
    ...pinnedTitle.map(frame.row),
    ...visibleBody.map(frame.row),
    ...(indicator ? [frame.row(indicator)] : []),
    ...visibleActions.map(frame.row),
    ...(rowLimit >= 2 ? [frame.bottom] : []),
  ]

  return { lines: lines.slice(0, rowLimit), maxOffset, pageSize }
}
