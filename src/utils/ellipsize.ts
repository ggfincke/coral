// src/utils/ellipsize.ts
// single-line string shorteners: cap with ellipsis and first-line excerpt

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
