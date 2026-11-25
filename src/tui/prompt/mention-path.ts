// src/tui/prompt/mention-path.ts
// encode and decode @-mention path tokens

export const MENTION_BOUNDARY = String.raw`(?:^|\s)@`
export const QUOTED_BODY = String.raw`(?:\\.|[^"\\])*`
export const UNQUOTED_RUN = String.raw`\S`

const NEEDS_QUOTING = /[\s"\\]/

const TRAILING_PUNCTUATION_RE = /(?<=[^./])[.,;:!?]+$/
const CLOSER_OPENER: Record<string, string> = { ')': '(', ']': '[' }

function countChar(text: string, ch: string): number
{
  return text.split(ch).length - 1
}

// an unquoted mention ends before sentence punctuation (`@a.ts.`, `@a.ts,`) and
// before a closer it never opened (`(see @a.ts)`); `..` segments stay whole
export function trimUnquotedMention(token: string): string
{
  let path = token
  for (;;)
  {
    const trimmed = path.replace(TRAILING_PUNCTUATION_RE, '')
    const closer = trimmed.at(-1) ?? ''
    const opener = CLOSER_OPENER[closer]
    const next =
      opener && countChar(trimmed, closer) > countChar(trimmed, opener)
        ? trimmed.slice(0, -1)
        : trimmed
    if (next === path || !next) return path
    path = next
  }
}

// quote whatever an unquoted mention could not carry back intact
export function encodeMentionPath(path: string): string
{
  if (!NEEDS_QUOTING.test(path) && trimUnquotedMention(path) === path)
    return path

  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function decodeMentionPath(token: string): string
{
  return token.replace(/\\(.)/g, '$1')
}
