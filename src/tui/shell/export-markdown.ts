// src/tui/shell/export-markdown.ts
// serialize stored conversation messages to portable markdown

import type { OllamaMessage } from '../../types/inference.js'

export interface ExportSource
{
  title?: string | null
  sessionId?: string | null
  model: string
  cwd?: string | null
  messages: readonly OllamaMessage[]
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

  for (const message of source.messages)
  {
    if (message.role === 'system') continue

    if (message.role === 'user')
    {
      lines.push('## User', '', message.content, '')
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
      if (message.content) lines.push(message.content, '')
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
