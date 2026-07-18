// src/tui/input/use-coral-input.ts
// connect normalized terminal input to Ink's shared event stream

import type { EventEmitter } from 'node:events'
import { useEffect, useRef } from 'react'
import { useStdin } from 'ink'
import {
  tokenizeTerminalChunk,
  toInputEvent,
  type CoralKey,
} from './terminal-input.js'

const ENABLE_MOUSE_TRACKING = '\x1b[?1000h\x1b[?1006h'
const DISABLE_MOUSE_TRACKING = '\x1b[?1006l\x1b[?1000l'

interface UseCoralInputOptions
{
  isActive?: boolean
  enableMouseTracking?: boolean
}

interface CoralStdinContext
{
  setRawMode: (value: boolean) => void
  internal_exitOnCtrlC: boolean
  internal_eventEmitter: EventEmitter
}

export function useCoralInput(
  handler: (input: string, key: CoralKey) => void,
  options: UseCoralInputOptions = {}
): void
{
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } =
    useStdin() as unknown as CoralStdinContext
  const { isActive = true, enableMouseTracking = false } = options
  const pendingRef = useRef('')
  const handlerRef = useRef(handler)

  useEffect(() =>
  {
    handlerRef.current = handler
  }, [handler])

  useEffect(() =>
  {
    if (!isActive) return

    setRawMode(true)

    return () =>
    {
      setRawMode(false)
    }
  }, [isActive, setRawMode])

  useEffect(() =>
  {
    if (!isActive || !enableMouseTracking) return

    process.stdout.write(ENABLE_MOUSE_TRACKING)

    return () =>
    {
      process.stdout.write(DISABLE_MOUSE_TRACKING)
    }
  }, [enableMouseTracking, isActive])

  useEffect(() =>
  {
    if (!isActive) return

    const handleData = (data: string | Buffer) =>
    {
      const raw = typeof data === 'string' ? data : data.toString()
      const { tokens, pending } = tokenizeTerminalChunk(raw, pendingRef.current)
      pendingRef.current = pending

      for (const token of tokens)
      {
        const event = toInputEvent(token)
        if (!event) continue
        if (event.input === 'c' && event.key.ctrl && internal_exitOnCtrlC)
        {
          continue
        }

        handlerRef.current(event.input, event.key)
      }
    }

    internal_eventEmitter.on('input', handleData)

    return () =>
    {
      pendingRef.current = ''
      internal_eventEmitter.removeListener('input', handleData)
    }
  }, [internal_eventEmitter, internal_exitOnCtrlC, isActive])
}
