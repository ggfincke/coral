// src/tui/transcript/sanitize.ts
// strip terminal control payloads from untrusted display text

import { isUnsafeTerminalControl } from '../../utils/untrusted-text.js'

export { sanitizeUntrustedText } from '../../utils/untrusted-text.js'

// strip dangerous terminal controls while preserving SGR color/style codes —
// for app-built text that mixes trusted chalk styling with untrusted fragments.
// SGR (CSI ... m) only sets colors and attributes, so it is safe to keep; OSC,
// cursor/screen controls, and other escapes are removed
export function sanitizeStyledText(text: string): string
{
  let result = ''
  let i = 0
  while (i < text.length)
  {
    const char = text[i]!
    const code = char.codePointAt(0)!

    if (code === 0x1b)
    {
      // CSI: ESC [ params/intermediates final — keep only SGR (final 'm')
      if (text[i + 1] === '[')
      {
        let j = i + 2
        while (j < text.length)
        {
          const byte = text.charCodeAt(j)
          if (byte < 0x20 || byte > 0x3f) break
          j++
        }
        if (text[j] === 'm') result += text.slice(i, j + 1)
        i = j + 1
        continue
      }

      // OSC: ESC ] ... terminated by BEL or ST (ESC \) — always dropped
      if (text[i + 1] === ']')
      {
        let j = i + 2
        while (j < text.length)
        {
          if (text.charCodeAt(j) === 0x07)
          {
            j++
            break
          }
          if (text[j] === '\x1b' && text[j + 1] === '\\')
          {
            j += 2
            break
          }
          j++
        }
        i = j
        continue
      }

      // any other escape sequence: drop ESC + its following byte
      i += 2
      continue
    }

    // drop dangerous C0/C1 controls but keep tabs and newlines
    if (isUnsafeTerminalControl(code) && char !== '\n' && char !== '\t')
    {
      i++
      continue
    }

    result += char
    i++
  }
  return result
}
