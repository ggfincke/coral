// src/retrieval/source-chunker.ts
// syntax-aware source chunks w/ bounded line-based fallback

import { extname } from 'node:path'
import type { Node } from 'typescript'
import { chunkText, MAX_CHUNK_CHARS, MAX_CHUNK_LINES } from './chunker.js'
import { CHUNKER_VERSION, type CodeChunk } from './types.js'

const SCRIPT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
])

interface SourceUnit
{
  start: number
  end: number
  node?: Node
}

export async function chunkSource(
  content: string,
  filePath?: string
): Promise<CodeChunk[]>
{
  const extension = extname(filePath ?? '').toLowerCase()
  if (!SCRIPT_EXTENSIONS.has(extension)) return chunkText(content)

  // loading the compiler is deferred until a supported file needs indexing
  const ts = (await import('typescript')).default
  const lines = content.split(/\r?\n/)
  while (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) return []

  const text = lines.join('\n')
  const source = ts.createSourceFile(
    filePath!,
    text,
    ts.ScriptTarget.Latest,
    false,
    extension === '.tsx'
      ? ts.ScriptKind.TSX
      : extension === '.jsx'
        ? ts.ScriptKind.JSX
        : ['.js', '.mjs', '.cjs'].includes(extension)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS
  )
  const offsets = [0]
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1)

  // match chunkText's newline convention, including source containing unicode separators
  const lineAt = (position: number): number =>
  {
    let low = 0
    let high = lines.length
    while (low + 1 < high)
    {
      const middle = Math.floor((low + high) / 2)
      if (offsets[middle] <= position) low = middle
      else high = middle
    }
    return low
  }

  const fits = ({ start, end }: SourceUnit): boolean =>
    end - start <= MAX_CHUNK_LINES &&
    offsets[end] - offsets[start] <= MAX_CHUNK_CHARS

  // gaps own headers and closing delimiters; overlapping node lines stay indivisible
  const partition = (
    nodes: readonly Node[],
    start: number,
    end: number
  ): SourceUnit[] | null =>
  {
    const units: SourceUnit[] = []
    let cursor = start
    let previousEnd = offsets[start]
    for (const node of nodes)
    {
      const fullStart = node.getFullStart()
      const tokenStart = node.getStart(source)
      if (
        fullStart < 0 ||
        fullStart > tokenStart ||
        tokenStart < previousEnd ||
        node.end <= tokenStart ||
        node.end > text.length
      )
        return null

      const tokenLine = lineAt(tokenStart)
      const triviaLine = lineAt(fullStart)
      const unitStart = Math.max(
        start,
        Math.min(
          tokenLine,
          triviaLine + (fullStart > offsets[triviaLine] ? 1 : 0)
        )
      )
      const unitEnd = lineAt(node.end - 1) + 1
      if (unitStart < start || unitEnd > end) return null

      if (unitStart < cursor)
      {
        const previous = units.at(-1)
        if (!previous) return null
        previous.end = unitEnd
        // a shared line may contain more than one declaration, so don't split it again
        previous.node = undefined
      }
      else
      {
        if (unitStart > cursor) units.push({ start: cursor, end: unitStart })
        units.push({ start: unitStart, end: unitEnd, node })
      }
      cursor = unitEnd
      previousEnd = node.end
    }
    if (cursor < end) units.push({ start: cursor, end })
    return units
  }

  const units = partition(source.statements, 0, lines.length)
  if (!units) return chunkText(content)

  const chunks: CodeChunk[] = []
  let pending: SourceUnit | undefined
  const flush = () =>
  {
    if (!pending) return
    const chunk = lines.slice(pending.start, pending.end).join('\n').trim()
    if (chunk)
    {
      chunks.push({
        chunkIndex: chunks.length,
        startLine: pending.start + 1,
        endLine: pending.end,
        text: chunk,
        chunkerVersion: CHUNKER_VERSION,
      })
    }
    pending = undefined
  }

  const append = (unit: SourceUnit): void =>
  {
    if (fits(unit))
    {
      if (pending && !fits({ start: pending.start, end: unit.end })) flush()
      pending = { start: pending?.start ?? unit.start, end: unit.end }
      return
    }

    // oversized leading trivia must not force a fitting declaration to split
    if (unit.node)
    {
      const tokenLine = lineAt(unit.node.getStart(source))
      if (tokenLine > unit.start && fits({ start: tokenLine, end: unit.end }))
      {
        append({ start: unit.start, end: tokenLine })
        append({ start: tokenLine, end: unit.end })
        return
      }
    }

    if (unit.node && ts.isClassDeclaration(unit.node))
    {
      const members = partition(unit.node.members, unit.start, unit.end)
      if (members)
      {
        for (const member of members) append(member)
        return
      }
    }

    flush()
    for (const chunk of chunkText(
      lines.slice(unit.start, unit.end).join('\n')
    ))
    {
      chunks.push({
        ...chunk,
        chunkIndex: chunks.length,
        startLine: chunk.startLine + unit.start,
        endLine: chunk.endLine + unit.start,
      })
    }
  }

  for (const unit of units) append(unit)
  flush()
  return chunks
}
