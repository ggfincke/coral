// src/tui/mention-path.ts
// encode & decode @-mention path tokens

export const MENTION_BOUNDARY = String.raw`(?:^|\s)@`
export const QUOTED_BODY = String.raw`(?:\\.|[^"\\])*`
export const UNQUOTED_RUN = String.raw`\S`

const NEEDS_QUOTING = /[\s"\\]/

export function encodeMentionPath(path: string): string
{
  if (!NEEDS_QUOTING.test(path)) return path

  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function decodeMentionPath(token: string): string
{
  return token.replace(/\\(.)/g, '$1')
}
