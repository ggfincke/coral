// src/tui/input/terminal-input.ts
// tokenize terminal packets and normalize keyboard and wheel input

import { parseKeypress, nonAlphanumericKeys } from './keypress.js'

const ESC = '\u001b'
const SGR_MOUSE_PACKET_RE = new RegExp(`^${ESC}\\[<(\\d+);\\d+;\\d+[Mm]$`)
const SGR_MOUSE_PREFIX_RE = new RegExp(`^${ESC}\\[<\\d+;\\d+;\\d+[Mm]`)
const SGR_MOUSE_FRAGMENT_RE = new RegExp(`^${ESC}\\[<[0-9;]*$`)
const BRACKETED_PASTE_PACKET_RE = new RegExp(`^${ESC}\\[(?:200|201)~$`)
const BRACKETED_PASTE_PREFIX_RE = new RegExp(`^${ESC}\\[(?:200|201)~`)
const BRACKETED_PASTE_FRAGMENT_RE = new RegExp(`^${ESC}\\[(?:2|20|200|201)?$`)
const FOCUS_PACKET_RE = new RegExp(`^${ESC}\\[[IO]$`)
const FOCUS_PREFIX_RE = new RegExp(`^${ESC}\\[[IO]`)
const FOCUS_FRAGMENT_RE = new RegExp(`^${ESC}\\[$`)
// fixed control-sequence anchors must stay in sync w/ the prefix, packet, and
// fragment regexes; add each new control type to every corresponding list
const CONTROL_PREFIXES = [
  '\x1b[<',
  '\x1b[200~',
  '\x1b[201~',
  '\x1b[I',
  '\x1b[O',
]
const WHEEL_UP = 0x40
const WHEEL_DOWN = 0x41
const WHEEL_MASK = 0x43

export interface CoralKey
{
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  home: boolean
  end: boolean
  pageDown: boolean
  pageUp: boolean
  return: boolean
  escape: boolean
  ctrl: boolean
  shift: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  meta: boolean
  wheelUp: boolean
  wheelDown: boolean
  functionKey?: string
}

export interface ParsedInputEvent
{
  input: string
  key: CoralKey
}

export interface TokenizedChunk
{
  tokens: string[]
  pending: string
}

export function buildKey(overrides: Partial<CoralKey> = {}): CoralKey
{
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    home: false,
    end: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    wheelUp: false,
    wheelDown: false,
    ...overrides,
  }
}

function parseMouseWheelPacket(input: string): 'up' | 'down' | 'other' | null
{
  const match = input.match(SGR_MOUSE_PACKET_RE)
  if (!match) return null

  const button = Number.parseInt(match[1]!, 10) & WHEEL_MASK
  if (button === WHEEL_UP) return 'up'
  if (button === WHEEL_DOWN) return 'down'
  return 'other'
}

function isControlFragment(input: string): boolean
{
  return (
    SGR_MOUSE_FRAGMENT_RE.test(input) ||
    BRACKETED_PASTE_FRAGMENT_RE.test(input) ||
    FOCUS_FRAGMENT_RE.test(input)
  )
}

function isIgnoredControlPacket(input: string): boolean
{
  return BRACKETED_PASTE_PACKET_RE.test(input) || FOCUS_PACKET_RE.test(input)
}

// the complete packets Ink 8 drops; see tapTerminalControls in control-tap.ts
export function isMouseOrFocusPacket(packet: string): boolean
{
  return SGR_MOUSE_PACKET_RE.test(packet) || FOCUS_PACKET_RE.test(packet)
}

function findNextControlIndex(input: string): number
{
  const indexes = CONTROL_PREFIXES.map((p) => input.indexOf(p)).filter(
    (index) => index >= 0
  )

  return indexes.length > 0 ? Math.min(...indexes) : -1
}

// C0 controls & DEL except ESC: Enter, Tab, and ctrl keys typed in a burst
function isControlByte(code: number): boolean
{
  return (code < 0x20 && code !== 0x1b) || code === 0x7f
}

// Ink splits only backspace & ctrl+c out of a text run, so `fix it\r` would be
// one event; give each control byte its own token. an ESC-led run is one
// escape sequence from Ink's parser and stays whole
function pushTextRun(tokens: string[], run: string): void
{
  if (run.startsWith(ESC))
  {
    tokens.push(run)
    return
  }

  let start = 0
  for (let index = 0; index < run.length; index++)
  {
    if (!isControlByte(run.charCodeAt(index))) continue
    if (index > start) tokens.push(run.slice(start, index))
    tokens.push(run[index]!)
    start = index + 1
  }
  if (start < run.length) tokens.push(run.slice(start))
}

export function tokenizeTerminalChunk(
  input: string,
  pending = ''
): TokenizedChunk
{
  const tokens: string[] = []
  let remaining = pending + input

  while (remaining.length > 0)
  {
    const mouseMatch = remaining.match(SGR_MOUSE_PREFIX_RE)
    if (mouseMatch)
    {
      tokens.push(mouseMatch[0])
      remaining = remaining.slice(mouseMatch[0].length)
      continue
    }

    const pasteMatch = remaining.match(BRACKETED_PASTE_PREFIX_RE)
    if (pasteMatch)
    {
      tokens.push(pasteMatch[0])
      remaining = remaining.slice(pasteMatch[0].length)
      continue
    }

    const focusMatch = remaining.match(FOCUS_PREFIX_RE)
    if (focusMatch)
    {
      tokens.push(focusMatch[0])
      remaining = remaining.slice(focusMatch[0].length)
      continue
    }

    if (isControlFragment(remaining))
    {
      return { tokens, pending: remaining }
    }

    const nextControlIndex = findNextControlIndex(remaining)
    if (nextControlIndex === -1)
    {
      // a read can end inside the next packet; hold that tail for the next read
      const tailStart = remaining.lastIndexOf(ESC)
      const tail = tailStart > 0 ? remaining.slice(tailStart) : ''
      if (tail && isControlFragment(tail))
      {
        pushTextRun(tokens, remaining.slice(0, tailStart))
        return { tokens, pending: tail }
      }
      pushTextRun(tokens, remaining)
      return { tokens, pending: '' }
    }

    if (nextControlIndex > 0)
    {
      pushTextRun(tokens, remaining.slice(0, nextControlIndex))
      remaining = remaining.slice(nextControlIndex)
      continue
    }

    tokens.push(remaining[0]!)
    remaining = remaining.slice(1)
  }

  return { tokens, pending: '' }
}

export function toInputEvent(packet: string): ParsedInputEvent | null
{
  const wheel = parseMouseWheelPacket(packet)
  if (wheel === 'up' || wheel === 'down')
  {
    return {
      input: '',
      key: buildKey({
        wheelUp: wheel === 'up',
        wheelDown: wheel === 'down',
      }),
    }
  }

  if (wheel === 'other' || isIgnoredControlPacket(packet))
  {
    return null
  }

  const keypress = parseKeypress(packet)
  const key = buildKey({
    upArrow: keypress.name === 'up',
    downArrow: keypress.name === 'down',
    leftArrow: keypress.name === 'left',
    rightArrow: keypress.name === 'right',
    home: keypress.name === 'home',
    end: keypress.name === 'end',
    pageDown: keypress.name === 'pagedown',
    pageUp: keypress.name === 'pageup',
    return: keypress.name === 'return',
    escape: keypress.name === 'escape',
    ctrl: keypress.ctrl,
    shift: keypress.shift,
    tab: keypress.name === 'tab',
    backspace: keypress.name === 'backspace',
    delete: keypress.name === 'delete',
    meta: keypress.meta || keypress.option,
  })

  // CSI-u printable keys carry their character in sequence rather than name
  let input = keypress.ctrl
    ? keypress.name ||
      (keypress.sequence.startsWith('\u001b')
        ? ''
        : keypress.sequence.toLowerCase())
    : keypress.sequence
  if (/^f(?:[1-9]|1[0-2])$/.test(keypress.name))
  {
    key.functionKey = keypress.name
  }
  if (nonAlphanumericKeys.includes(keypress.name))
  {
    input = ''
  }

  // an escape sequence that names no key (F13+, unmapped CSI) is not text; a
  // meta chord is ESC plus one character
  if (input.startsWith(ESC) && !keypress.name && [...input].length > 2)
  {
    input = ''
  }
  if (input.startsWith('\u001B'))
  {
    input = input.slice(1)
  }

  if (input.length === 1 && /[A-Z]/.test(input[0]!))
  {
    key.shift = true
  }

  return { input, key }
}
