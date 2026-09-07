// src/tui/transcript/code-highlight.ts
// bounded reuse of successful terminal code highlighting

import chalk from 'chalk'
import highlighter from 'cli-highlight'
import { getThemeGeneration } from '../theme.js'

const MAX_ENTRIES = 32
const MAX_PAYLOAD_BYTES = 4 * 1_024 * 1_024
const cache = new Map<string, { output: string; bytes: number }>()
let payloadBytes = 0
let presentation = ''

export function highlightCode(text: string, language?: string): string
{
  const trimmed = text.replace(/\n$/, '')
  if (!trimmed) return ''

  const currentPresentation = `${getThemeGeneration()}:${chalk.level}`
  if (presentation !== currentPresentation)
  {
    cache.clear()
    payloadBytes = 0
    presentation = currentPresentation
  }
  const key = JSON.stringify([language ?? null, text])
  const cached = cache.get(key)
  if (cached)
  {
    cache.delete(key)
    cache.set(key, cached)
    return cached.output
  }

  try
  {
    if (language && !highlighter.supportsLanguage(language)) return trimmed
    const output = highlighter.highlight(trimmed, {
      ...(language ? { language } : {}),
      ignoreIllegals: true,
    })
    const bytes = (key.length + output.length) * 2
    if (bytes <= MAX_PAYLOAD_BYTES)
    {
      while (
        cache.size >= MAX_ENTRIES ||
        payloadBytes + bytes > MAX_PAYLOAD_BYTES
      )
      {
        const oldest = cache.keys().next().value!
        payloadBytes -= cache.get(oldest)!.bytes
        cache.delete(oldest)
      }
      cache.set(key, { output, bytes })
      payloadBytes += bytes
    }
    return output
  }
  catch
  {
    return trimmed
  }
}
