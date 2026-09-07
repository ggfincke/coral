// src/tui/shell/links.ts
// build OSC 8 terminal hyperlinks for file paths w/ plain-text fallback

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ESC = '\u001b'
const OSC8_OPEN = `${ESC}]8;;`
const OSC8_CLOSE = `${ESC}\\`

// control chars (C0 + DEL) are stripped so a label can't smuggle escape
// sequences past the hyperlink wrapper; built w/ fromCharCode because
// literal control chars in regexes are lint-banned
const CONTROL_CHARS = [
  ...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)),
  String.fromCharCode(127),
]

export function osc8Enabled(pref: boolean): boolean
{
  return pref
}

function stripControlChars(label: string): string
{
  let result = label
  for (const char of CONTROL_CHARS)
  {
    result = result.split(char).join('')
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
  if (!osc8Enabled(enabled))
  {
    return label
  }

  const target = pathToFileURL(
    resolve(opts?.cwd ?? process.cwd(), filePath)
  ).href
  const safeLabel = stripControlChars(label)
  return `${OSC8_OPEN}${target}${OSC8_CLOSE}${safeLabel}${OSC8_OPEN}${OSC8_CLOSE}`
}
