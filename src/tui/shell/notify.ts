// src/tui/shell/notify.ts
// pure escape-sequence builders for bell, desktop notifications, and focus-aware gating

const OSC_PAYLOAD_MAX = 200

// strip ESC/BEL/other C0 controls and bidi overrides, collapse whitespace runs,
// trim, then cap so OSC payloads stay single-line and injection-free
const controlChar = (code: number): string => String.fromCharCode(code)
const OSC_STRIP_PATTERN = new RegExp(
  `[${controlChar(0)}-${controlChar(31)}${controlChar(127)}\u202a-\u202e]`,
  'g'
)

export function sanitizeOscPayload(text: string): string
{
  return text
    .replace(OSC_STRIP_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, OSC_PAYLOAD_MAX)
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
