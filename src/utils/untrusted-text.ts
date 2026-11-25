// src/utils/untrusted-text.ts
// neutral terminal-control stripping, visible control escaping, and fail-safe display serialization

const ESC = 0x1b
const BEL = 0x07
const C1_CSI = 0x9b
const C1_ST = 0x9c

export function isUnsafeTerminalControl(code: number): boolean
{
  return (
    code <= 0x08 ||
    (code >= 0x0b && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  )
}

// default-ignorable and format code points (bidi controls, zero-width marks,
// variation selectors, fillers, tags) render as nothing in Ink, and line or
// paragraph separators break rows, so approval surfaces escape them too
const INVISIBLE_FORMAT_CHAR =
  /^[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Zl}\p{Zp}]$/u

// U+00AD is the lowest such code point, so plain ASCII skips the regex
function isInvisibleFormatChar(code: number): boolean
{
  return code >= 0xad && INVISIBLE_FORMAT_CHAR.test(String.fromCodePoint(code))
}

function isHiddenChar(code: number): boolean
{
  return (
    (isUnsafeTerminalControl(code) && code !== 0x09 && code !== 0x0a) ||
    isInvisibleFormatChar(code)
  )
}

function isCsiIntermediate(char: string | undefined): boolean
{
  return char !== undefined && '[]()#;?'.includes(char)
}

function isDigit(char: string | undefined): boolean
{
  return char !== undefined && char >= '0' && char <= '9'
}

// final bytes accepted by the CSI branch of ansi-regex
function isCsiFinal(char: string | undefined): boolean
{
  if (char === undefined) return false
  return /^[\dA-PR-TZcf-nq-uy=><~]$/.test(char)
}

// end (exclusive) of a CSI-like sequence at start, or -1; mirrors ansi-regex's
// greedy-then-backtrack choice by taking the longest param run whose next char
// is a final byte
function csiSequenceEnd(text: string, start: number): number
{
  let pos = start + 1
  while (isCsiIntermediate(text[pos])) pos++

  const ends = [pos]
  let digits = 0
  while (digits < 4 && isDigit(text[pos]))
  {
    pos++
    digits++
    ends.push(pos)
  }
  if (digits > 0)
  {
    while (text[pos] === ';' || text[pos] === ':')
    {
      pos++
      ends.push(pos)
      digits = 0
      while (digits < 4 && isDigit(text[pos]))
      {
        pos++
        digits++
        ends.push(pos)
      }
    }
  }

  for (let index = ends.length - 1; index >= 0; index--)
  {
    const end = ends[index]!
    if (isCsiFinal(text[end])) return end + 1
  }
  return -1
}

// end (exclusive) of the first OSC terminator at or after from, or -1
function oscTerminatorEnd(text: string, from: number): number
{
  for (let pos = from; pos < text.length; pos++)
  {
    const code = text.charCodeAt(pos)
    if (code === BEL || code === C1_ST) return pos + 1
    if (code === ESC && text[pos + 1] === '\\') return pos + 2
  }
  return -1
}

// drop ANSI sequences & unsafe controls w/ strip-ansi's sequence rules in one
// linear scan; after one OSC search fails, later OSC starts skip the rescan so
// unterminated `ESC ]` runs stay linear
export function sanitizeUntrustedText(text: string): string
{
  let sanitized = ''
  let unterminatedFrom = Number.POSITIVE_INFINITY
  let pos = 0
  while (pos < text.length)
  {
    const code = text.charCodeAt(pos)
    if (code === ESC && text[pos + 1] === ']' && pos + 2 < unterminatedFrom)
    {
      const end = oscTerminatorEnd(text, pos + 2)
      if (end !== -1)
      {
        pos = end
        continue
      }
      unterminatedFrom = pos + 2
    }
    if (code === ESC || code === C1_CSI)
    {
      const end = csiSequenceEnd(text, pos)
      if (end !== -1)
      {
        pos = end
        continue
      }
    }

    const point = text.codePointAt(pos)!
    const char = String.fromCodePoint(point)
    if (!isUnsafeTerminalControl(point)) sanitized += char
    pos += char.length
  }
  return sanitized
}

// one-row display of untrusted text w/ ANSI sequences & controls removed,
// whitespace runs collapsed, ends trimmed; approval surfaces escape instead
// through flattenUntrustedText so nothing that runs is hidden
export function sanitizeUntrustedLine(text: string): string
{
  return sanitizeUntrustedText(text).replace(/\s+/g, ' ').trim()
}

// ASCII controls read as `\xNN`; anything wider uses the braced `\u{...}`
// form so an astral code point never reads as four digits plus a literal
function escapeHiddenChar(code: number): string
{
  return code < 0x80
    ? `\\x${code.toString(16).padStart(2, '0')}`
    : `\\u{${code.toString(16)}}`
}

// a CR right before LF is an ordinary CRLF line ending, not a hidden control
function isLineEndingCr(text: string, pos: number): boolean
{
  return text.charCodeAt(pos) === 0x0d && text.charCodeAt(pos + 1) === 0x0a
}

const VS15 = 0xfe0e
const VS16 = 0xfe0f
const ZWJ = 0x200d
const COMBINING_KEYCAP = 0x20e3
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u
const EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u
const KEYCAP_BASE = /^[0-9#*]$/

function matchesCodePoint(pattern: RegExp, code: number | undefined): boolean
{
  return code !== undefined && pattern.test(String.fromCodePoint(code))
}

// the code point that ends right before pos, if any
function codePointBefore(text: string, pos: number): number | undefined
{
  if (pos === 0) return undefined
  const low = text.charCodeAt(pos - 1)
  const high = text.charCodeAt(pos - 2)
  const isPair =
    low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff
  return isPair ? text.codePointAt(pos - 2) : low
}

// ordinary emoji presentation renders inside a visible glyph: VS15/VS16 right
// after a pictograph or keycap base, or a ZWJ joining two pictographs (the
// first may carry VS16 or a skin tone); stray or repeated ones stay escaped
function isEmojiPresentation(text: string, pos: number, code: number): boolean
{
  if (code === VS15 || code === VS16)
  {
    const before = codePointBefore(text, pos)
    if (matchesCodePoint(PICTOGRAPH, before)) return true
    return (
      matchesCodePoint(KEYCAP_BASE, before) &&
      text.charCodeAt(pos + 1) === COMBINING_KEYCAP
    )
  }
  if (code !== ZWJ) return false
  if (!matchesCodePoint(PICTOGRAPH, text.codePointAt(pos + 1))) return false

  let before = codePointBefore(text, pos)
  if (before === VS16 || matchesCodePoint(EMOJI_MODIFIER, before))
  {
    before = codePointBefore(text, pos - (before! > 0xffff ? 2 : 1))
  }
  return matchesCodePoint(PICTOGRAPH, before)
}

function isHiddenAt(text: string, pos: number, code: number): boolean
{
  return isHiddenChar(code) && !isEmojiPresentation(text, pos, code)
}

// show hidden chars as `\xNN` / `\u{...}` text so approval prompts, tool
// headers, and diffs never omit bytes that will run; tab, newline, CRLF, and
// emoji presentation stay as they are
export function revealUntrustedText(text: string): string
{
  let revealed = ''
  for (let pos = 0; pos < text.length;)
  {
    const code = text.codePointAt(pos)!
    const char = String.fromCodePoint(code)
    if (!isLineEndingCr(text, pos))
    {
      revealed += isHiddenAt(text, pos, code) ? escapeHiddenChar(code) : char
    }
    pos += char.length
  }
  return revealed
}

// true when revealUntrustedText would escape something; drives warning rows
export function hasHiddenControls(text: string): boolean
{
  for (let pos = 0; pos < text.length;)
  {
    const code = text.codePointAt(pos)!
    if (isHiddenAt(text, pos, code) && !isLineEndingCr(text, pos)) return true
    pos += code > 0xffff ? 2 : 1
  }
  return false
}

// one-row display of untrusted text: controls shown escaped, whitespace runs
// collapsed to single spaces, ends trimmed
export function flattenUntrustedText(text: string): string
{
  return revealUntrustedText(text).replace(/\s+/g, ' ').trim()
}

export function stringifyForDisplay(value: unknown, space?: number): string
{
  const seen = new WeakSet<object>()
  try
  {
    return (
      JSON.stringify(
        value,
        (_key, item: unknown) =>
        {
          if (typeof item === 'bigint') return `[BigInt: ${item}]`
          if (typeof item !== 'object' || item === null) return item
          if (seen.has(item)) return '[Circular]'
          seen.add(item)
          return item
        },
        space
      ) ?? ''
    )
  }
  catch
  {
    return '[Unserializable value]'
  }
}
