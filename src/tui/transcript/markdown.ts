// src/tui/transcript/markdown.ts
// render markdown to ANSI-styled terminal text

import chalk from 'chalk'
import { lexer, type Token, type Tokens } from 'marked'
import { highlightCode } from './code-highlight.js'
import { codeSpanStyle, headingStyle, style } from '../theme.js'
import { expandTabs, padEnd, visibleWidth } from '../wrap.js'
import { sanitizeUntrustedText } from './sanitize.js'

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

// marked decodes numeric character references (`&#27;`) after the source was
// sanitized, so decoded leaves are sanitized again before they are styled
function renderInline(tokens: Token[] | undefined): string
{
  if (!tokens?.length) return ''

  let output = ''

  for (const token of tokens)
  {
    switch (token.type)
    {
      case 'text':
        output += token.tokens?.length
          ? renderInline(token.tokens)
          : sanitizeUntrustedText(token.text)
        break
      case 'escape':
        output += sanitizeUntrustedText(token.text)
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
        const href = sanitizeUntrustedText(token.href)
        const label = renderInline(token.tokens) || href
        const renderedLabel = style('user').underline(label)
        output +=
          label === href
            ? renderedLabel
            : `${renderedLabel}${chalk.dim(` (${href})`)}`
        break
      }
      case 'image':
        output += style('accent')(
          `[image: ${sanitizeUntrustedText(token.text || token.href)}]`
        )
        break
      case 'br':
        output += '\n'
        break
      // loose task items carry the checkbox inline; the bullet shows it
      case 'checkbox':
        break
      default:
        output += sanitizeUntrustedText(
          'text' in token ? token.text : token.raw
        )
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
    const cellWidths = rows.map((row) => visibleWidth(row[index] ?? ''))
    return Math.max(visibleWidth(cell), ...cellWidths, 1)
  })

  const separator = chalk.dim(
    widths.map((width) => '─'.repeat(width)).join('─┼─')
  )
  const renderRow = (cells: string[]) =>
    pad +
    cells
      .map((cell, index) => padEnd(cell, widths[index] ?? 1))
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
    // only loose lists (items split by blank lines) keep a blank between items
    if (lines.length > 0 && token.loose) lines.push('')

    const checkbox = item.task ? `${item.checked ? '[x]' : '[ ]'} ` : ''
    const bullet = token.ordered
      ? `${orderedStart + index}. ${checkbox}`
      : checkbox || '• '
    const content = renderBlocks(item.tokens, 0, token.loose)

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
    // the task bullet already shows the checkbox state
    case 'checkbox':
      return []
    case 'paragraph':
      return renderInline(token.tokens)
        .split('\n')
        .map((line) => pad + line)
    // tight list items hold their inline content in block-level text tokens
    case 'text':
      return (
        token.tokens
          ? renderInline(token.tokens)
          : sanitizeUntrustedText(token.text)
      )
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
                Math.max(visibleWidth(text), 8)
              )
            ),
        ]
      }

      return [heading]
    }
    case 'blockquote':
    {
      const quoted = renderBlocks((token as Tokens.Blockquote).tokens, 0)
      const bq = pad + chalk.dim('│ ')
      return prefixLines(quoted, bq)
    }
    case 'list':
      return renderList(token as Tokens.List, indent)
    case 'code':
    {
      const code = token as Tokens.Code
      const fence = pad + chalk.dim('┌─ ') + style('code')(code.lang || 'code')
      const codePrefix = pad + chalk.dim('│ ')
      const highlighted = highlightCode(expandTabs(code.text), code.lang)
      const codeLines = (highlighted || '')
        .split('\n')
        .map((line) => codePrefix + line)
      return [fence, ...codeLines, pad + chalk.dim('└─')]
    }
    case 'table':
      return renderTable(token as Tokens.Table, indent)
    case 'hr':
      return [pad + chalk.dim('─'.repeat(40))]
    case 'html':
      return sanitizeUntrustedText((token as Tokens.HTML).text)
        .split('\n')
        .map((line: string) => pad + line)
    default:
      return sanitizeUntrustedText('raw' in token ? token.raw : '')
        .split('\n')
        .filter(Boolean)
        .map((line) => pad + line)
  }
}

// blocks are separated by a blank row, except inside a tight list item
function renderBlocks(
  tokens: Token[],
  indent: number,
  spaced = true
): string[]
{
  const rendered: string[] = []

  for (const token of tokens)
  {
    const block = renderBlock(token, indent)

    if (block.length === 0) continue
    if (rendered.length > 0 && spaced) rendered.push('')
    rendered.push(...block)
  }

  return rendered
}

export function renderMarkdownToAnsi(markdown: string): string
{
  const sanitized = sanitizeUntrustedText(markdown)
  if (!sanitized.trim()) return ''
  return renderBlocks(lexer(sanitized), 0).join('\n')
}
