// src/tui/prompt/paste.ts
// pure bracketed-paste handling for Coral's inline prompt

const ESC = '\u001b'
const PASTE_START_MARKER_RE = new RegExp(`${ESC}\\[200~`, 'g')
const PASTE_END_MARKER_RE = new RegExp(`${ESC}\\[201~`, 'g')
const OSC_PATTERN_RE = new RegExp(
  `${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\)`,
  'g'
)
const CSI_PATTERN_RE = new RegExp(`${ESC}\\[[0-9;:?]*[A-Za-z]`, 'g')
// keep \t (\x09) & \n (\x0a); drop every other C0 control plus DEL
const controlChar = (code: number): string => String.fromCharCode(code)
const CONTROL_PATTERN_RE = new RegExp(
  `[${controlChar(0)}-${controlChar(8)}${controlChar(11)}${controlChar(12)}${controlChar(14)}-${controlChar(31)}${controlChar(127)}]`,
  'g'
)

// pasted content can carry terminal styling from the source app; strip it so
// a paste can never inject escape sequences into the composer
export function sanitizePastedText(raw: string): string
{
  return raw
    .replace(OSC_PATTERN_RE, '')
    .replace(PASTE_START_MARKER_RE, '')
    .replace(PASTE_END_MARKER_RE, '')
    .replace(CSI_PATTERN_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_PATTERN_RE, '')
}

// single-line pastes up to this size insert literally; anything longer or any
// multi-line paste becomes a one-line placeholder w/ second-Enter confirmation
export const PLACEHOLDER_MIN_CHARS = 1_000

export function shouldPlaceholderize(text: string): boolean
{
  return text.includes('\n') || text.length > PLACEHOLDER_MIN_CHARS
}

// newline count + 1, matching how terminals number pasted lines
export function countPastedLines(text: string): number
{
  let lines = 1
  for (let i = 0; i < text.length; i += 1)
  {
    if (text[i] === '\n') lines += 1
  }
  return lines
}

export function buildPastePlaceholder(id: number, text: string): string
{
  return `[Pasted text #${id} +${countPastedLines(text)} lines]`
}

export const PASTE_STORE_LIMIT = 100_000
const PASTE_KEEP_HEAD = 50_000
const PASTE_KEEP_TAIL = 50_000

export interface BoundedPaste
{
  text: string
  truncatedChars: number
}

// cap what we retain for send-time expansion; beyond the limit only a bounded
// head/tail survives, matching the session persistence ceiling's spirit
export function boundPastedText(text: string): BoundedPaste
{
  if (text.length <= PASTE_STORE_LIMIT)
  {
    return { text, truncatedChars: 0 }
  }

  const truncatedChars = text.length - (PASTE_KEEP_HEAD + PASTE_KEEP_TAIL)
  return {
    text:
      text.slice(0, PASTE_KEEP_HEAD) +
      `\n[Pasted text truncated: ${truncatedChars} chars dropped]\n` +
      text.slice(text.length - PASTE_KEEP_TAIL),
    truncatedChars,
  }
}

const PLACEHOLDER_PATTERN = /\[Pasted text #(\d+) \+\d+ lines\]/g

// splice stored full texts in place of their tokens at send time; unknown or
// hand-typed lookalikes stay literal so user prose is never rewritten
export function expandPastePlaceholders(
  value: string,
  resolve: (id: number) => string | undefined
): string
{
  return value.replace(PLACEHOLDER_PATTERN, (token, rawId) =>
  {
    const id = Number.parseInt(rawId, 10)
    if (!Number.isFinite(id)) return token
    return resolve(id) ?? token
  })
}
