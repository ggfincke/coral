// src/tui/input/control-tap.ts
// forward the mouse & focus reports Ink 8 drops before its input event

import { EventEmitter } from 'node:events'
import {
  isMouseOrFocusPacket,
  tokenizeTerminalChunk,
} from './terminal-input.js'

// * process-wide because Ink reads one stdin; useCoralInput and
// useTerminalModes subscribe here for packets Ink no longer emits
export const terminalControlEvents = new EventEmitter()

// Ink flushes a pending escape as keys after 20ms, so an older held tail
// belongs to no packet
const PENDING_TAIL_MS = 20

// wrap the stdin handed to render() so every chunk Ink reads is also scanned;
// a Proxy keeps listeners & raw mode on the real stream
export function tapTerminalControls(
  stdin: NodeJS.ReadStream
): NodeJS.ReadStream
{
  let pending = ''
  let pendingAt = 0
  const read = (size?: number) =>
  {
    const chunk: unknown = stdin.read(size)
    if (chunk !== null)
    {
      const text = String(chunk)
      const now = Date.now()
      if (now - pendingAt > PENDING_TAIL_MS) pending = ''
      const parsed = tokenizeTerminalChunk(text, pending)
      pending = parsed.pending
      // a burst can end on the ESC that opens the next packet; a lone ESC
      // read is the Escape key and is never held
      if (!pending && text.length > 1 && text.endsWith('\x1b')) pending = '\x1b'
      pendingAt = now
      for (const token of parsed.tokens)
      {
        if (isMouseOrFocusPacket(token))
        {
          terminalControlEvents.emit('packet', token)
        }
      }
    }
    return chunk
  }

  return new Proxy(stdin, {
    get(target, property)
    {
      if (property === 'read') return read
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
