// src/tui/shell/links.ts
// build OSC 8 terminal hyperlinks for file paths w/ plain-text fallback

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isUnsafeTerminalControl } from '../../utils/untrusted-text.js'

const ESC = '\u001b'
const OSC8_OPEN = `${ESC}]8;;`
const OSC8_CLOSE = `${ESC}\\`

// every terminal control (C0, DEL, C1) is stripped so a label can't smuggle
// escape sequences past the hyperlink wrapper; tab & newline go too
function stripControlChars(label: string): string
{
  let result = ''
  for (const char of label)
  {
    const code = char.codePointAt(0)!
    if (code !== 0x09 && code !== 0x0a && !isUnsafeTerminalControl(code))
      result += char
  }
  return result
}

// wraps <label> in an OSC 8 hyperlink pointing at the resolved absolute path;
// relative paths anchor to the active workspace; disabled output is the label verbatim
export function buildFileLink(
  filePath: string,
  label: string,
  opts?: { enabled?: boolean; cwd?: string }
): string
{
  const enabled = opts?.enabled ?? false
  if (!enabled) return label

  const target = pathToFileURL(
    resolve(opts?.cwd ?? process.cwd(), filePath)
  ).href
  const safeLabel = stripControlChars(label)
  return `${OSC8_OPEN}${target}${OSC8_CLOSE}${safeLabel}${OSC8_OPEN}${OSC8_CLOSE}`
}
