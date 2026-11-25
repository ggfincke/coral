// src/tui/transcript/stream-markdown.ts
// progressive markdown styling for streaming assistant text

import chalk from 'chalk'
import { renderMarkdownToAnsi } from './markdown.js'
import { sanitizeUntrustedText } from './sanitize.js'
import { getThemeGeneration } from '../theme.js'
import { wrapLines } from '../wrap.js'

export interface StreamingSplit
{
  // paragraphs proven complete: fenced blocks balanced & no open table
  stableText: string
  // everything after the last provable boundary renders plain until it settles
  unstableTail: string
}

// any indent opens so fences nested in list items are tracked too
const FENCE_LINE = /^([ \t]*)(`{3,}|~{3,})(.*)$/
const TABLE_ROW = /^\s*\|/

function isTableRow(line: string): boolean
{
  return TABLE_ROW.test(line)
}

// open fence: marker char, run length, and leading columns of its line
interface OpenFence
{
  marker: string
  length: number
  indent: number
}

// leading whitespace in columns, tabs advancing to the next 4-column stop
function indentColumns(whitespace: string): number
{
  let columns = 0
  for (const char of whitespace)
  {
    columns = char === '\t' ? columns - (columns % 4) + 4 : columns + 1
  }
  return columns
}

// commonmark closes on the same char, at least the opening length, nothing
// but spaces after, and 0-3 columns of indent inside the fence's container;
// the container is unknown mid-stream, so the opening indent stands in for it
function closesFence(
  fence: OpenFence,
  indent: number,
  marker: string,
  suffix: string
): boolean
{
  return (
    marker[0] === fence.marker &&
    marker.length >= fence.length &&
    indent < fence.indent + 4 &&
    !suffix.trim()
  )
}

// walk paragraph boundaries keeping only provably settled prefixes: a
// boundary counts when fences are balanced and neither the closing nor the
// next line looks like a table row (mid-stream tables must never flicker)
export function splitStableMarkdown(text: string): StreamingSplit
{
  if (!text) return { stableText: '', unstableTail: '' }

  const lines = text.split('\n')
  let fence: OpenFence | null = null
  let stableEnd = 0

  for (let i = 0; i < lines.length; i++)
  {
    const line = lines[i]!
    const match = FENCE_LINE.exec(line)
    if (match)
    {
      const indent = indentColumns(match[1]!)
      const marker = match[2]!
      const suffix = match[3]!
      if (fence)
      {
        if (closesFence(fence, indent, marker, suffix)) fence = null
      }
      else if (marker[0] !== '`' || !suffix.includes('`'))
      {
        fence = { marker: marker[0]!, length: marker.length, indent }
      }
    }

    if (line.trim() === '' && !fence)
    {
      const prev = lines[i - 1] ?? ''
      const next = lines[i + 1]
      const nextIsTable = next !== undefined && isTableRow(next)
      if (!prev || (!isTableRow(prev) && !nextIsTable))
      {
        stableEnd = i + 1
      }
    }
  }

  if (stableEnd <= 0)
  {
    return { stableText: '', unstableTail: text }
  }

  return {
    stableText: lines.slice(0, stableEnd).join('\n'),
    unstableTail: lines.slice(stableEnd).join('\n'),
  }
}

// cache keyed by the exact stable text: between paragraph boundaries the
// styled region is byte-identical every frame, so lexing runs only when a
// boundary actually advances
interface StableRenderCache
{
  key: string
  lines: string[]
}
const STABLE_RENDER_CACHES = new Map<string, StableRenderCache>()

function renderStableRegion(
  stableText: string,
  width: number,
  themeGeneration: number
): string[]
{
  if (!stableText.trim()) return []

  const key = `${themeGeneration}:${chalk.level}:${width}`
  const cached = STABLE_RENDER_CACHES.get(key)
  if (cached && cached.key === stableText) return cached.lines

  const lines = wrapLines(renderMarkdownToAnsi(stableText), width - 3, '   ')
  STABLE_RENDER_CACHES.set(key, { key: stableText, lines })
  // one entry per (generation,width) keeps memory bounded across themes
  if (STABLE_RENDER_CACHES.size > 8)
  {
    const oldest = STABLE_RENDER_CACHES.keys().next().value
    if (oldest !== undefined) STABLE_RENDER_CACHES.delete(oldest)
  }
  return lines
}

// styled completed paragraphs + plain live tail; malformed mid-stream
// constructs stay in the plain region so nothing flickers or half-renders
export function renderStreamingMarkdown(
  content: string,
  width: number,
  themeGeneration: number = getThemeGeneration()
): string[]
{
  const { stableText, unstableTail } = splitStableMarkdown(content)
  const lines = [...renderStableRegion(stableText, width, themeGeneration)]

  if (unstableTail)
  {
    // the tail starts a new block, so keep the blank row the final render has
    if (lines.length > 0) lines.push('   ')
    lines.push(
      ...wrapLines(sanitizeUntrustedText(unstableTail), width - 3, '   ')
    )
  }

  return lines
}
