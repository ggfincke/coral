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

// wrap the stdin handed to render() so every chunk Ink reads is also scanned;
// a Proxy keeps listeners & raw mode on the real stream
export function tapTerminalControls(
  stdin: NodeJS.ReadStream
): NodeJS.ReadStream
{
  let pending = ''
  const read = (size?: number) =>
  {
    const chunk: unknown = stdin.read(size)
    if (chunk !== null)
    {
      const parsed = tokenizeTerminalChunk(String(chunk), pending)
      pending = parsed.pending
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
