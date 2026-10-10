// src/utils/ellipsize.ts
// string shorteners: cap with ellipsis, by UTF-8 bytes, and first-line excerpt

// drop a trailing lone high surrogate left by code-unit slicing
export function trimTrailingHighSurrogate(text: string): string
{
  const last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text
}

// drop a leading lone low surrogate left by code-unit tail slicing
export function trimLeadingLowSurrogate(text: string): string
{
  const first = text.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text
}

// cap text to max chars, appending the glyph so the result never exceeds max
export function ellipsize(text: string, max: number, glyph = '…'): string
{
  if (text.length <= max) return text
  // when max can't fit text + glyph, return as much of the glyph as fits
  if (max <= glyph.length) return glyph.slice(0, Math.max(max, 0))
  return trimTrailingHighSurrogate(text.slice(0, max - glyph.length)) + glyph
}

// first non-blank line, trimmed
function firstLine(text: string): string
{
  const lines = text.split('\n')
  return (lines.find((line) => line.trim().length > 0) ?? '').trim()
}

// first line of text, capped to max chars with an ellipsis
export function excerpt(text: string, max: number): string
{
  return ellipsize(firstLine(text), max)
}

// cap text to max UTF-8 bytes without splitting a code point
export function truncateUtf8(text: string, maxBytes: number): string
{
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text
  let result = ''
  let used = 0
  for (const character of text)
  {
    const bytes = Buffer.byteLength(character, 'utf-8')
    if (used + bytes > maxBytes) break
    result += character
    used += bytes
  }
  return result
}
