// src/tui/input/use-terminal-modes.ts
// own terminal modes, focus reporting, and suspension for the App lifetime

import type { EventEmitter } from 'node:events'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp, useStdin, useStdout } from 'ink'
import { tokenizeTerminalChunk, toInputEvent } from './terminal-input.js'

const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h'
const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1000l'
const DISABLE_MODES = '\x1b[?1004l\x1b[?1006l\x1b[?1000l'

export function useTerminalModes({
  enableMouseTracking,
}: {
  enableMouseTracking: boolean
}): {
  focused: boolean | null
  suspendTerminal: (callback: () => Promise<void>) => Promise<void>
}
{
  const { suspendTerminal: suspendInk } = useApp()
  const { stdout } = useStdout()
  const { internal_eventEmitter } = useStdin() as unknown as {
    internal_eventEmitter: EventEmitter
  }
  const [focused, setFocused] = useState<boolean | null>(null)
  const mountedRef = useRef(false)
  const suspendedRef = useRef(false)

  const writeModes = useCallback(
    (enabled: boolean) =>
    {
      if (!stdout.isTTY || !stdout.writable) return
      stdout.write(
        enabled
          ? (enableMouseTracking ? ENABLE_MOUSE : DISABLE_MOUSE) + '\x1b[?1004h'
          : DISABLE_MODES
      )
    },
    [enableMouseTracking, stdout]
  )

  const suspendTerminal = useCallback(
    async (callback: () => Promise<void>) =>
    {
      if (suspendedRef.current) return
      suspendedRef.current = true
      writeModes(false)
      setFocused(null)
      try
      {
        // leave raw mode, bracketed paste, kitty state, and rendering to Ink
        await suspendInk(callback)
      }
      finally
      {
        suspendedRef.current = false
        if (mountedRef.current) writeModes(true)
      }
    },
    [suspendInk, writeModes]
  )

  useEffect(() =>
  {
    mountedRef.current = true
    writeModes(true)
    let pending = ''

    const suspendJob = () =>
    {
      if (process.platform === 'win32' || suspendedRef.current) return
      void suspendTerminal(
        () =>
          new Promise<void>((resolve, reject) =>
          {
            const resume = () =>
            {
              if (mountedRef.current) process.on('SIGTSTP', suspendJob)
              resolve()
            }
            process.removeListener('SIGTSTP', suspendJob)
            process.once('SIGCONT', resume)
            try
            {
              process.kill(process.pid, 'SIGTSTP')
            }
            catch (error)
            {
              process.removeListener('SIGCONT', resume)
              if (mountedRef.current) process.on('SIGTSTP', suspendJob)
              reject(error)
            }
          })
      ).catch(() => undefined)
    }

    const handleData = (data: string | Buffer) =>
    {
      const raw = typeof data === 'string' ? data : data.toString()
      const parsed = tokenizeTerminalChunk(raw, pending)
      pending = parsed.pending
      for (const token of parsed.tokens)
      {
        if (token === '\x1b[I' || token === '\x1b[O')
        {
          setFocused(token === '\x1b[I')
          continue
        }
        const event = toInputEvent(token)
        if (event?.key.ctrl && event.input === 'z') suspendJob()
      }
    }
    internal_eventEmitter.on('input', handleData)
    if (process.platform !== 'win32') process.on('SIGTSTP', suspendJob)

    return () =>
    {
      mountedRef.current = false
      internal_eventEmitter.removeListener('input', handleData)
      process.removeListener('SIGTSTP', suspendJob)
      writeModes(false)
    }
  }, [internal_eventEmitter, suspendTerminal, writeModes])

  return { focused, suspendTerminal }
}
