// src/tui/use-stream-buffer.ts
// buffered streaming state for assistant text & reasoning

import { useCallback, useRef, useState } from 'react'
import type { OutputBlock } from './transcript.js'

export interface StreamBuffer
{
  text: string
  thinking: string
}

// convert buffered stream content into finalized transcript blocks
export function buildBufferedOutputBlocks(buffer: StreamBuffer): OutputBlock[]
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
    if (flushTimerRef.current)
    {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
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

  const consumeBufferedBlocks = useCallback((): OutputBlock[] =>
  {
    clearFlushTimer()

    const blocks = buildBufferedOutputBlocks({
      text: streamTextRef.current,
      thinking: streamThinkingRef.current,
    })

    streamTextRef.current = ''
    streamThinkingRef.current = ''
    setStreamBuf({ text: '', thinking: '' })

    return blocks
  }, [clearFlushTimer])

  const resetStreamBuffer = useCallback(() =>
  {
    clearFlushTimer()
    streamTextRef.current = ''
    streamThinkingRef.current = ''
    setStreamBuf({ text: '', thinking: '' })
  }, [clearFlushTimer])

  return {
    streamBuf,
    appendText,
    appendThinking,
    consumeBufferedBlocks,
    resetStreamBuffer,
  }
}
