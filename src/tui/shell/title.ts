// src/tui/shell/title.ts
// terminal window-title builders with braille spinner frames for run state

import { basename } from 'node:path'
import { sanitizeOscPayload } from './notify.js'

// the 10 standard braille spinner frames, cycled in order while a turn runs
export const BRAILLE_FRAMES: readonly string[] = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
]

const TITLE_MAX = 120

// OSC 0 title w/ the same sanitization as notifications, capped at 120 chars
export function buildTerminalTitle(text: string): string
{
  return `\u001b]0;${sanitizeOscPayload(text).slice(0, TITLE_MAX)}\u0007`
}

// '<frame> coral · <basename(cwd)>', cycling frames modulo length; double
// modulo keeps negative indices inside array bounds instead of undefined
export function formatRunningTitle(frameIndex: number, cwd: string): string
{
  const len = BRAILLE_FRAMES.length
  const idx = ((frameIndex % len) + len) % len
  const frame = BRAILLE_FRAMES[idx] ?? ''
  return `${frame} coral · ${basename(cwd)}`
}

// '[!] action required · <basename(cwd)>' while waiting on permission
export function formatBlockedTitle(cwd: string): string
{
  return `[!] action required · ${basename(cwd)}`
}

// 'coral · <basename(cwd)>' when no turn is active
export function formatIdleTitle(cwd: string): string
{
  return `coral · ${basename(cwd)}`
}
