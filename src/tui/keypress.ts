// src/tui/keypress.ts
// parse terminal keypresses for Coral's shared input layer

import { Buffer } from 'node:buffer'

const ESC = '\u001b'
const META_KEY_CODE_RE = new RegExp(`^(?:${ESC})([a-zA-Z0-9])$`)
const FN_KEY_RE = new RegExp(
  `^(?:${ESC}+)(O|N|\\[|\\[\\[)(?:(\\d+)(?:;(\\d+))?([~^$])|(?:1;)?(\\d+)?([a-zA-Z]))`
)
const KEY_NAME: Record<string, string> = {
  OP: 'f1',
  OQ: 'f2',
  OR: 'f3',
  OS: 'f4',
  '[11~': 'f1',
  '[12~': 'f2',
  '[13~': 'f3',
  '[14~': 'f4',
  '[[A': 'f1',
  '[[B': 'f2',
  '[[C': 'f3',
  '[[D': 'f4',
  '[[E': 'f5',
  '[15~': 'f5',
  '[17~': 'f6',
  '[18~': 'f7',
  '[19~': 'f8',
  '[20~': 'f9',
  '[21~': 'f10',
  '[23~': 'f11',
  '[24~': 'f12',
  '[A': 'up',
  '[B': 'down',
  '[C': 'right',
  '[D': 'left',
  '[E': 'clear',
  '[F': 'end',
  '[H': 'home',
  OA: 'up',
  OB: 'down',
  OC: 'right',
  OD: 'left',
  OE: 'clear',
  OF: 'end',
  OH: 'home',
  '[1~': 'home',
  '[2~': 'insert',
  '[3~': 'delete',
  '[4~': 'end',
  '[5~': 'pageup',
  '[6~': 'pagedown',
  '[[5~': 'pageup',
  '[[6~': 'pagedown',
  '[7~': 'home',
  '[8~': 'end',
  '[a': 'up',
  '[b': 'down',
  '[c': 'right',
  '[d': 'left',
  '[e': 'clear',
  '[2$': 'insert',
  '[3$': 'delete',
  '[5$': 'pageup',
  '[6$': 'pagedown',
  '[7$': 'home',
  '[8$': 'end',
  Oa: 'up',
  Ob: 'down',
  Oc: 'right',
  Od: 'left',
  Oe: 'clear',
  '[2^': 'insert',
  '[3^': 'delete',
  '[5^': 'pageup',
  '[6^': 'pagedown',
  '[7^': 'home',
  '[8^': 'end',
  '[Z': 'tab',
}

export const nonAlphanumericKeys = [...Object.values(KEY_NAME), 'backspace']
const SHIFT_CODES = new Set([
  '[a',
  '[b',
  '[c',
  '[d',
  '[e',
  '[2$',
  '[3$',
  '[5$',
  '[6$',
  '[7$',
  '[8$',
  '[Z',
])
const CTRL_CODES = new Set([
  'Oa',
  'Ob',
  'Oc',
  'Od',
  'Oe',
  '[2^',
  '[3^',
  '[5^',
  '[6^',
  '[7^',
  '[8^',
])

interface ParsedKey
{
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  option: boolean
  sequence: string
  raw?: string
  code?: string
}

function isShiftKey(code: string): boolean
{
  return SHIFT_CODES.has(code)
}

function isCtrlKey(code: string): boolean
{
  return CTRL_CODES.has(code)
}

export function parseKeypress(input: string | Buffer = ''): ParsedKey
{
  let value = input
  let parts: RegExpExecArray | null

  if (Buffer.isBuffer(value))
  {
    if (value[0] > 127 && value[1] === undefined)
    {
      value[0] -= 128
      value = `\x1b${String(value)}`
    }
    else
    {
      value = String(value)
    }
  }
  else if (value !== undefined && typeof value !== 'string')
  {
    value = String(value)
  }
  else if (!value)
  {
    value = ''
  }

  const key: ParsedKey = {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: value,
    raw: value,
  }

  key.sequence = key.sequence || value || key.name

  if (value === '\r')
  {
    key.raw = undefined
    key.name = 'return'
  }
  else if (value === '\n')
  {
    key.name = 'enter'
  }
  else if (value === '\t')
  {
    key.name = 'tab'
  }
  else if (value === '\b' || value === '\x1b\b')
  {
    key.name = 'backspace'
    key.meta = value.charAt(0) === '\x1b'
    // map the mac Delete key to backward-delete semantics
  }
  else if (value === '\x7f' || value === '\x1b\x7f')
  {
    key.name = 'backspace'
    key.meta = value.charAt(0) === '\x1b'
  }
  else if (value === '\x1b' || value === '\x1b\x1b')
  {
    key.name = 'escape'
    key.meta = value.length === 2
  }
  else if (value === ' ' || value === '\x1b ')
  {
    key.name = 'space'
    key.meta = value.length === 2
  }
  else if (value === '\x1f')
  {
    key.name = '_'
    key.ctrl = true
  }
  else if (value.length === 1 && value <= '\x1a')
  {
    key.name = String.fromCharCode(value.charCodeAt(0) + 'a'.charCodeAt(0) - 1)
    key.ctrl = true
  }
  else if (value.length === 1 && value >= '0' && value <= '9')
  {
    key.name = 'number'
  }
  else if (value.length === 1 && value >= 'a' && value <= 'z')
  {
    key.name = value
  }
  else if (value.length === 1 && value >= 'A' && value <= 'Z')
  {
    key.name = value.toLowerCase()
    key.shift = true
  }
  else if ((parts = META_KEY_CODE_RE.exec(value)))
  {
    key.meta = true
    key.shift = /^[A-Z]$/.test(parts[1]!)
  }
  else if ((parts = FN_KEY_RE.exec(value)))
  {
    const segments = [...value]
    if (segments[0] === '\u001b' && segments[1] === '\u001b')
    {
      key.option = true
    }

    const code = [parts[1], parts[2], parts[4], parts[6]]
      .filter(Boolean)
      .join('')
    const modifier = Number(parts[3] || parts[5] || 1) - 1

    key.ctrl = !!(modifier & 4)
    key.meta = !!(modifier & 2)
    key.shift = !!(modifier & 1)
    key.code = code
    key.name = KEY_NAME[code] ?? ''
    key.shift = isShiftKey(code) || key.shift
    key.ctrl = isCtrlKey(code) || key.ctrl
  }

  // handle iTerm natural text editing word movement
  if (key.raw === '\x1Bb')
  {
    key.meta = true
    key.name = 'left'
  }
  else if (key.raw === '\x1Bf')
  {
    key.meta = true
    key.name = 'right'
  }

  return key
}
