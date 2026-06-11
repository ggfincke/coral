// src/tui/markdown.ts
// render markdown to ANSI-styled terminal text

import chalk from 'chalk'
import { highlight, supportsLanguage } from 'cli-highlight'
import { lexer, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { codeSpanStyle, headingStyle, style } from './theme.js'

function padAnsiEnd(value: string, width: number): string
{
  const visibleLength = stripAnsi(value).length
  return value + ' '.repeat(Math.max(width - visibleLength, 0))
}

function prefixLines(
  lines: string[],
  firstPrefix: string,
  restPrefix = firstPrefix
): string[]
{
  return lines.map((line, index) =>
  {
    if (!line) return ''
    return (index === 0 ? firstPrefix : restPrefix) + line
  })
}

function highlightCode(text: string, language?: string): string
{
  const trimmed = text.replace(/\n$/, '')

  if (!trimmed) return ''

  try
  {
    if (language && supportsLanguage(language))
    {
      return highlight(trimmed, { language, ignoreIllegals: true })
    }

    return language ? trimmed : highlight(trimmed, { ignoreIllegals: true })
  }
  catch
  {
    return trimmed
  }
}

function renderInline(tokens: Token[] | undefined): string
{
  if (!tokens?.length) return ''

  let output = ''

  for (const token of tokens)
  {
    switch (token.type)
    {
      case 'text':
        output += token.tokens?.length ? renderInline(token.tokens) : token.text
        break
      case 'escape':
        output += token.text
        break
      case 'strong':
        output += chalk.bold(renderInline(token.tokens))
        break
      case 'em':
        output += chalk.italic(renderInline(token.tokens))
        break
      case 'del':
        output += chalk.strikethrough(renderInline(token.tokens))
        break
      case 'codespan':
        output += codeSpanStyle()(` ${token.text} `)
        break
      case 'link':
      {
        const label = renderInline(token.tokens) || token.href
        const renderedLabel = style('user').underline(label)
        output +=
          label === token.href
            ? renderedLabel
            : `${renderedLabel}${chalk.dim(` (${token.href})`)}`
        break
      }
      case 'image':
        output += style('accent')(`[image: ${token.text || token.href}]`)
        break
      case 'br':
        output += '\n'
        break
      case 'html':
        output += token.text
        break
      default:
        output += 'text' in token ? token.text : token.raw
        break
    }
  }

  return output
}

function renderTable(token: Tokens.Table, indent: number): string[]
{
  const pad = ' '.repeat(indent)
  const header = token.header.map((cell) => renderInline(cell.tokens))
  const rows = token.rows.map((row) =>
    row.map((cell) => renderInline(cell.tokens))
  )
  const widths = header.map((cell, index) =>
  {
    const cellWidths = rows.map((row) => stripAnsi(row[index] ?? '').length)
    return Math.max(stripAnsi(cell).length, ...cellWidths, 1)
  })

  const separator = chalk.dim(
    widths.map((width) => '─'.repeat(width)).join('─┼─')
  )
  const renderRow = (cells: string[]) =>
    pad +
    cells
      .map((cell, index) => padAnsiEnd(cell, widths[index] ?? 1))
      .join(chalk.dim(' │ '))

  return [
    renderRow(header.map((cell) => chalk.bold(cell))),
    pad + separator,
    ...rows.map(renderRow),
  ]
}

function renderList(token: Tokens.List, indent: number): string[]
{
  const pad = ' '.repeat(indent)
  const lines: string[] = []
  const orderedStart = typeof token.start === 'number' ? token.start : 1

  token.items.forEach((item, index) =>
  {
    if (lines.length > 0) lines.push('')

    const bullet = token.ordered
      ? `${orderedStart + index}. `
      : item.task
        ? `${item.checked ? '[x]' : '[ ]'} `
        : '• '
    const content = renderBlocks(item.tokens, 0)

    if (content.length === 0)
    {
      lines.push(pad + bullet.trimEnd())
      return
    }

    lines.push(
      ...prefixLines(content, pad + bullet, pad + ' '.repeat(bullet.length))
    )
  })

  return lines
}

function renderBlock(token: Token, indent: number): string[]
{
  const pad = ' '.repeat(indent)

  switch (token.type)
  {
    case 'space':
      return []
    case 'paragraph':
      return renderInline(token.tokens)
        .split('\n')
        .map((line) => pad + line)
    case 'heading':
    {
      const text = renderInline(token.tokens)
      const heading = pad + headingStyle(token.depth)(text)

      if (token.depth <= 2)
      {
        return [
          heading,
          pad +
            chalk.dim(
              (token.depth === 1 ? '=' : '-').repeat(
                Math.max(stripAnsi(text).length, 8)
              )
            ),
        ]
      }

      return [heading]
    }
    case 'blockquote':
    {
      const quoted = renderBlocks((token as Tokens.Blockquote).tokens, 0)
      return prefixLines(quoted, pad + chalk.dim('│ '), pad + chalk.dim('│ '))
    }
    case 'list':
      return renderList(token as Tokens.List, indent)
    case 'code':
    {
      const code = token as Tokens.Code
      const fence = pad + chalk.dim(code.lang ? `\`\`\` ${code.lang}` : '```')
      const codePrefix = pad + chalk.dim('│ ')
      const highlighted = highlightCode(code.text, code.lang)
      const codeLines = (highlighted || '')
        .split('\n')
        .map((line) => codePrefix + line)
      return [fence, ...codeLines, pad + chalk.dim('```')]
    }
    case 'table':
      return renderTable(token as Tokens.Table, indent)
    case 'hr':
      return [pad + chalk.dim('─'.repeat(40))]
    case 'html':
      return (token as Tokens.HTML).text
        .split('\n')
        .map((line: string) => pad + line)
    default:
      return ('raw' in token ? token.raw : '')
        .split('\n')
        .filter(Boolean)
        .map((line) => pad + line)
  }
}

function renderBlocks(tokens: Token[], indent: number): string[]
{
  const rendered: string[] = []

  for (const token of tokens)
  {
    const block = renderBlock(token, indent)

    if (block.length === 0) continue
    if (rendered.length > 0) rendered.push('')
    rendered.push(...block)
  }

  return rendered
}

export function renderMarkdownToAnsi(markdown: string): string
{
  if (!markdown.trim()) return ''
  return renderBlocks(lexer(markdown), 0).join('\n')
}
