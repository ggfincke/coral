// src/tui/run/approval-box.ts
// bordered tool & MCP launch approval prompt content & bounded viewport render

import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'
import type { McpLaunchApprovalRequest } from '../../mcp/types.js'
import type { ToolCallPresentation } from '../../tools/tool.js'
import { trimTrailingHighSurrogate } from '../../utils/ellipsize.js'
import { renderUnifiedDiff } from '../transcript/diff.js'
import { summarizeToolArgs } from '../transcript/transcript.js'
import { boxFrame } from './status-line.js'
import { style } from '../theme.js'
import { sanitizeUntrustedText } from '../transcript/sanitize.js'

// cap change previews so large edits don't swallow the screen
const MAX_PREVIEW_LINES = 20
const MAX_MCP_APPROVAL_ARG_CHARS = 8_000
// minimum body rows shown even on tiny terminals
const MIN_BODY_ROWS = 3

// pre-wrapped prompt content: title & actions stay pinned, body scrolls
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

  const wrapInto = (
    target: string[],
    content: string,
    decorate: (line: string) => string = (line) => line
  ) =>
  {
    const wrapped = wrapAnsi(content, innerWidth, {
      hard: true,
      trim: false,
      wordWrap: true,
    })
    for (const line of wrapped.split('\n'))
    {
      target.push(decorate(line))
    }
  }

  return {
    innerWidth,
    warn,
    title: (content) => wrapInto(titleLines, content, warn),
    push: (content, decorate) => wrapInto(bodyLines, content, decorate),
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
  // MCP calls carry a presentation snapshot — no name-prefix sniffing here;
  // the naming convention stays owned by the manager
  if (presentation?.mcp)
  {
    const json = sanitizeUntrustedText(JSON.stringify(args, null, 2))
    if (json.length <= MAX_MCP_APPROVAL_ARG_CHARS) return json
    return `${trimTrailingHighSurrogate(json.slice(0, MAX_MCP_APPROVAL_ARG_CHARS))}\n… [MCP arguments truncated]`
  }
  const summary = summarizeToolArgs(toolName, args)
  return toolName === 'bash' ? `$ ${summary}` : summary
}

// lines come back fully styled; render w/o an outer Ink color prop so the
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

  box.title(`Allow ${toolName}?`)
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
  box.push(`Fingerprint: ${cleanLaunchValue(request.fingerprint)}`)
  box.blank()
  box.push(
    'This process is not sandboxed & may access the host, filesystem, or network.',
    box.warn
  )

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

// frame content into at most maxRows terminal rows; title & actions stay
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

  // fixed rows: top, blank, title, blank+action+blank, bottom
  const fixedRows = 2 + content.titleLines.length + 3 + 1
  const fitsWithoutIndicator = fixedRows + content.bodyLines.length <= maxRows

  let visibleBody = content.bodyLines
  let indicator: string | null = null
  let maxOffset = 0
  let pageSize = Math.max(content.bodyLines.length, 1)

  if (!fitsWithoutIndicator)
  {
    const bodyRows = Math.max(maxRows - fixedRows - 1, MIN_BODY_ROWS)
    maxOffset = Math.max(content.bodyLines.length - bodyRows, 0)
    const offset = Math.min(Math.max(scrollOffset, 0), maxOffset)
    visibleBody = content.bodyLines.slice(offset, offset + bodyRows)
    pageSize = bodyRows
    indicator = chalk.dim(
      `… lines ${offset + 1}-${offset + visibleBody.length} of ${content.bodyLines.length} — ↑/↓ scroll · PgUp/PgDn page`
    )
  }

  const lines: string[] = [frame.top, frame.row('')]
  for (const title of content.titleLines)
  {
    lines.push(frame.row(title))
  }
  for (const body of visibleBody)
  {
    lines.push(frame.row(body))
  }
  if (indicator) lines.push(frame.row(indicator))
  lines.push(frame.row(''))
  lines.push(frame.row(content.actionLine))
  lines.push(frame.row(''))
  lines.push(frame.bottom)

  return { lines, maxOffset, pageSize }
}
