// src/utils/ellipsize.ts
// single-line string shorteners: cap w/ ellipsis & first-line excerpt

// cap text to max chars, appending the glyph so the result never exceeds max
export function ellipsize(text: string, max: number, glyph = '…'): string
{
  if (text.length <= max) return text
  // when max can't fit text + glyph, return as much of the glyph as fits
  if (max <= glyph.length) return glyph.slice(0, Math.max(max, 0))
  return text.slice(0, max - glyph.length) + glyph
}

// first non-blank line, trimmed
function firstLine(text: string): string
{
  const lines = text.split('\n')
  return (lines.find((line) => line.trim().length > 0) ?? '').trim()
}

// first line of text, capped to max chars w/ an ellipsis
export function excerpt(text: string, max: number): string
{
  return ellipsize(firstLine(text), max)
}
