// src/tui/run/use-stream-buffer.ts
// buffered streaming state for assistant text and reasoning

import { useCallback, useRef, useState } from 'react'
import { clearTimerRef } from './clear-timer-ref.js'
import type { OutputBlock } from '../transcript/types.js'

export interface StreamBuffer
{
  text: string
  thinking: string
  // wall clock of the last appended token chunk; null until one arrives
  lastTokenAt: number | null
}

// convert buffered stream content into finalized transcript blocks
function buildBufferedOutputBlocks(buffer: StreamBuffer): OutputBlock[]
{
  const blocks: OutputBlock[] = []

  if (buffer.thinking)
  {
    blocks.push({ type: 'thinking', content: buffer.thinking })
  }

  if (buffer.text)
  {
    blocks.push({ type: 'assistant', content: buffer.text })
  }

  return blocks
}

// batch streamed content so fast token bursts don't re-render every chunk
export function useStreamBuffer(flushInterval: number): {
  streamBuf: StreamBuffer
  appendText: (chunk: string) => void
  appendThinking: (chunk: string) => void
  consumeBufferedBlocks: () => OutputBlock[]
  resetStreamBuffer: () => void
}
{
  const [streamBuf, setStreamBuf] = useState<StreamBuffer>({
    text: '',
    thinking: '',
    lastTokenAt: null,
  })

  const streamTextRef = useRef('')
  const streamThinkingRef = useRef('')
  const lastTokenAtRef = useRef<number | null>(null)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushStreaming = useCallback(() =>
  {
    flushTimerRef.current = null
    setStreamBuf({
      text: streamTextRef.current,
      thinking: streamThinkingRef.current,
      lastTokenAt: lastTokenAtRef.current,
    })
  }, [])

  const clearFlushTimer = useCallback(() =>
  {
    clearTimerRef(flushTimerRef)
  }, [])

  const scheduleFlush = useCallback(() =>
  {
    if (!flushTimerRef.current)
    {
      flushTimerRef.current = setTimeout(flushStreaming, flushInterval)
    }
  }, [flushInterval, flushStreaming])

  const appendText = useCallback(
    (chunk: string) =>
    {
      streamTextRef.current += chunk
      lastTokenAtRef.current = Date.now()
      scheduleFlush()
    },
    [scheduleFlush]
  )

  const appendThinking = useCallback(
    (chunk: string) =>
    {
      streamThinkingRef.current += chunk
      lastTokenAtRef.current = Date.now()
      scheduleFlush()
    },
    [scheduleFlush]
  )

  const clearBuffers = useCallback(() =>
  {
    clearFlushTimer()
    streamTextRef.current = ''
    streamThinkingRef.current = ''
    lastTokenAtRef.current = null
    setStreamBuf({ text: '', thinking: '', lastTokenAt: null })
  }, [clearFlushTimer])

  const consumeBufferedBlocks = useCallback((): OutputBlock[] =>
  {
    const blocks = buildBufferedOutputBlocks({
      text: streamTextRef.current,
      thinking: streamThinkingRef.current,
      lastTokenAt: lastTokenAtRef.current,
    })

    clearBuffers()

    return blocks
  }, [clearBuffers])

  const resetStreamBuffer = clearBuffers

  return {
    streamBuf,
    appendText,
    appendThinking,
    consumeBufferedBlocks,
    resetStreamBuffer,
  }
}
