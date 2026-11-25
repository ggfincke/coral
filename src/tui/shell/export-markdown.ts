// src/tui/shell/export-markdown.ts
// serialize stored conversation messages to portable markdown

import { lexer } from 'marked'
import type { OllamaMessage } from '../../types/inference.js'
import { findUserTurnStarts, type UndoTurn } from '../../types/undo.js'
import { formatMentionNotice } from '../prompt/mentions.js'
import { findCompactionHandoffs } from '../transcript/restored-blocks.js'

export interface ExportSource
{
  title?: string | null
  sessionId?: string | null
  model: string
  cwd?: string | null
  messages: readonly OllamaMessage[]
  // undo provenance that marks internal corrective prompts inside a turn
  undo?: readonly UndoTurn[]
}

export interface ExportOptions
{
  includeTools?: boolean
  includeThinking?: boolean
}

function fence(body: string): string
{
  let longestRun = 0
  for (const match of body.matchAll(/`+/g))
  {
    longestRun = Math.max(longestRun, match[0].length)
  }
  const delimiter = '`'.repeat(Math.max(3, longestRun + 1))
  return `${delimiter}\n${body}\n${delimiter}`
}

// a heading that only an unterminated top-level fence can swallow
const FENCE_PROBE = '\n\n# coral-export-fence-probe'

// a fenced code block's opening run, after up to 3 spaces of indent
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/u

// close a code fence a raw body left open (an interrupted answer) so it
// cannot swallow every later section of the export; marked decides what is
// open, so fences ended by a quote, list, or indented code are left alone
function closeOpenFence(body: string): string
{
  const tokens = lexer(body + FENCE_PROBE).filter(
    (token) => token.type !== 'space'
  )
  const last = tokens[tokens.length - 1]
  if (last?.type !== 'code') return body
  const opener = FENCE_OPENER.exec(last.raw)
  return opener ? `${body}\n${opener[1]}` : body
}

// the handoff header is model-facing framing; keep only the summary itself
function handoffSummary(content: string): string
{
  const split = content.indexOf('\n\n')
  return split === -1 ? content : content.slice(split + 2)
}

// markdown document w/ a metadata header and one section per exchange;
// system-role framing is internal context and deliberately excluded
export function buildSessionMarkdown(
  source: ExportSource,
  options: ExportOptions = {}
): string
{
  const lines: string[] = []
  const title = source.title?.trim() || 'Coral session'

  lines.push(`# ${title}`, '')
  lines.push('- model: ' + source.model)
  if (source.sessionId) lines.push('- session: ' + source.sessionId)
  if (source.cwd) lines.push('- cwd: ' + source.cwd)
  lines.push('- exported: ' + new Date().toISOString())
  lines.push('', '---', '')

  const turnStarts = new Set(findUserTurnStarts(source.messages, source.undo))
  const handoffs = findCompactionHandoffs(source.messages)
  for (const [index, message] of source.messages.entries())
  {
    if (message.role === 'system') continue

    if (message.role === 'user')
    {
      if (handoffs.has(index))
      {
        lines.push(
          '## Earlier conversation (summary)',
          '',
          closeOpenFence(handoffSummary(message.content)),
          ''
        )
        continue
      }
      // internal corrective prompts were never typed by the user
      if (!turnStarts.has(index)) continue

      lines.push(
        '## User',
        '',
        closeOpenFence(message.displayContent ?? message.content),
        ''
      )
      const notice = message.attachmentReport
        ? formatMentionNotice(message.attachmentReport)
        : null
      if (notice) lines.push(`_${notice}_`, '')
      continue
    }

    if (message.role === 'assistant')
    {
      lines.push('## Assistant', '')
      if (options.includeThinking && message.thinking)
      {
        lines.push(
          '<details><summary>thinking</summary>',
          '',
          fence(message.thinking),
          '',
          '</details>',
          ''
        )
      }
      if (options.includeTools && message.tool_calls?.length)
      {
        for (const call of message.tool_calls)
        {
          const args = JSON.stringify(call.function?.arguments ?? {})
          lines.push(
            `**tool call:** \`${call.function?.name ?? 'unknown'}\``,
            '',
            fence(args),
            ''
          )
        }
      }
      if (message.content) lines.push(closeOpenFence(message.content), '')
      continue
    }

    // tool role
    if (options.includeTools)
    {
      lines.push(
        `### Tool result — ${message.tool_name ?? 'unknown'}`,
        '',
        fence(message.content),
        ''
      )
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === '')
  {
    lines.pop()
  }
  lines.push('')

  return lines.join('\n')
}
