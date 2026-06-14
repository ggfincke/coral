// src/retrieval/chunker.ts
// deterministic line-based source chunking

import { CHUNKER_VERSION, type CodeChunk } from './types.js'

const MAX_CHUNK_LINES = 80
const OVERLAP_LINES = 10
const MAX_CHUNK_CHARS = 6_000

export function chunkText(content: string): CodeChunk[]
{
  const lines = content.split(/\r?\n/)
  while (lines.at(-1) === '')
  {
    lines.pop()
  }

  if (lines.length === 0) return []

  const chunks: CodeChunk[] = []
  let start = 0

  while (start < lines.length)
  {
    let end = start
    let chars = 0

    while (end < lines.length && end - start < MAX_CHUNK_LINES)
    {
      const nextChars = lines[end]!.length + 1
      if (end > start && chars + nextChars > MAX_CHUNK_CHARS) break

      chars += nextChars
      end++
    }

    if (end === start) end++

    const text = lines.slice(start, end).join('\n').trim()
    if (text)
    {
      chunks.push({
        chunkIndex: chunks.length,
        startLine: start + 1,
        endLine: end,
        text,
        chunkerVersion: CHUNKER_VERSION,
      })
    }

    if (end >= lines.length) break
    start = Math.max(end - OVERLAP_LINES, start + 1)
  }

  return chunks
}
