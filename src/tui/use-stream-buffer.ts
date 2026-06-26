// src/tui/use-stream-buffer.ts
// buffered streaming state for assistant text & reasoning

import { useCallback, useRef, useState } from 'react'
import { clearTimerRef } from './clear-timer-ref.js'
import type { OutputBlock } from './transcript.js'

export interface StreamBuffer
{
  text: string
  thinking: string
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
  })

  const streamTextRef = useRef('')
  const streamThinkingRef = useRef('')
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushStreaming = useCallback(() =>
  {
    flushTimerRef.current = null
    setStreamBuf({
      text: streamTextRef.current,
      thinking: streamThinkingRef.current,
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
      scheduleFlush()
    },
    [scheduleFlush]
  )

  const appendThinking = useCallback(
    (chunk: string) =>
    {
      streamThinkingRef.current += chunk
      scheduleFlush()
    },
    [scheduleFlush]
  )

  const clearBuffers = useCallback(() =>
  {
    clearFlushTimer()
    streamTextRef.current = ''
    streamThinkingRef.current = ''
    setStreamBuf({ text: '', thinking: '' })
  }, [clearFlushTimer])

  const consumeBufferedBlocks = useCallback((): OutputBlock[] =>
  {
    const blocks = buildBufferedOutputBlocks({
      text: streamTextRef.current,
      thinking: streamThinkingRef.current,
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
