// src/utils/untrusted-text.ts
// neutral terminal-control stripping and fail-safe display serialization

import stripAnsi from 'strip-ansi'

export function isUnsafeTerminalControl(code: number): boolean
{
  return (
    code <= 0x08 ||
    (code >= 0x0b && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  )
}

export function sanitizeUntrustedText(text: string): string
{
  let sanitized = ''
  for (const char of stripAnsi(text))
  {
    const code = char.codePointAt(0)
    if (code === undefined || isUnsafeTerminalControl(code)) continue
    sanitized += char
  }
  return sanitized
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
