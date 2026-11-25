// src/tui/shell/notify.ts
// pure escape-sequence builders for bell, desktop notifications, and focus-aware gating

import { isUnsafeTerminalControl } from '../../utils/untrusted-text.js'

const OSC_PAYLOAD_MAX = 200

// every terminal control (C0, DEL, C1) plus bidi embeddings, overrides, and
// isolates is stripped so a payload can't end the sequence early or reorder it
function isOscStripped(code: number): boolean
{
  return (
    code === 0x09 ||
    code === 0x0a ||
    isUnsafeTerminalControl(code) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

// strip, collapse whitespace runs, trim, then cap so OSC payloads stay
// single-line and injection-free
export function sanitizeOscPayload(text: string): string
{
  let kept = ''
  for (const char of text)
  {
    if (!isOscStripped(char.codePointAt(0)!)) kept += char
  }
  return kept.replace(/\s+/g, ' ').trim().slice(0, OSC_PAYLOAD_MAX)
}

// bare BEL byte -> audible/visual ping for terminals without OSC 9 support
export function buildBell(): string
{
  return '\u0007'
}

// OSC 9 desktop notification; body segment only when non-empty, '' when both empty
export function buildDesktopNotification(title: string, body?: string): string
{
  const safeTitle = sanitizeOscPayload(title)
  const safeBody = sanitizeOscPayload(body ?? '')
  if (!safeTitle && !safeBody) return ''

  const payload = safeBody ? `${safeTitle};${safeBody}` : safeTitle
  return `\u001b]9;${payload}\u0007`
}

// fire when enabled unless the terminal is definitely focused;
// unknown focus (null) counts as unfocused -> conservative notify
export function shouldNotifyFocusAware(
  focused: boolean | null,
  enabled: boolean
): boolean
{
  return enabled && focused !== true
}
