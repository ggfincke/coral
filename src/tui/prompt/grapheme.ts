// src/tui/prompt/grapheme.ts
// shared grapheme boundaries for prompt editing

import { clamp } from '../../utils/clamp.js'

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
})

// arrow/delete keys reuse the current value's boundaries across editor modes
let graphemeCache: { value: string; offsets: number[] } | null = null

export function graphemeOffsets(value: string): readonly number[]
{
  if (graphemeCache && graphemeCache.value === value)
    return graphemeCache.offsets
  const offsets: number[] = []
  for (const segment of GRAPHEME_SEGMENTER.segment(value))
    offsets.push(segment.index)
  offsets.push(value.length)
  graphemeCache = { value, offsets }
  return offsets
}

export function isGraphemeBoundary(value: string, offset: number): boolean
{
  if (offset <= 0 || offset >= value.length) return true

  const offsets = graphemeOffsets(value)
  let lo = 0
  let hi = offsets.length - 1
  while (lo <= hi)
  {
    const mid = (lo + hi) >> 1
    if (offsets[mid] === offset) return true
    if (offsets[mid] < offset) lo = mid + 1
    else hi = mid - 1
  }

  return false
}

export function previousGraphemeOffset(value: string, offset: number): number
{
  const clamped = clamp(offset, 0, value.length)
  if (clamped <= 0) return 0

  // largest offset strictly less than clamped
  const offsets = graphemeOffsets(value)
  let lo = 0
  let hi = offsets.length - 1
  let result = 0
  while (lo <= hi)
  {
    const mid = (lo + hi) >> 1
    if (offsets[mid] < clamped)
    {
      result = offsets[mid]
      lo = mid + 1
    }
    else hi = mid - 1
  }

  return result
}

export function nextGraphemeOffset(value: string, offset: number): number
{
  const clamped = clamp(offset, 0, value.length)
  if (clamped >= value.length) return value.length

  // smallest offset strictly greater than clamped
  const offsets = graphemeOffsets(value)
  let lo = 0
  let hi = offsets.length - 1
  let result = value.length
  while (lo <= hi)
  {
    const mid = (lo + hi) >> 1
    if (offsets[mid] > clamped)
    {
      result = offsets[mid]
      hi = mid - 1
    }
    else lo = mid + 1
  }

  return result
}

// insert cursors stay after joined text; normal cursors stay on its start
export function clampGraphemeOffset(
  value: string,
  offset: number,
  direction: 'backward' | 'forward' = 'backward'
): number
{
  const clamped = clamp(offset, 0, value.length)
  if (isGraphemeBoundary(value, clamped)) return clamped
  return direction === 'forward'
    ? nextGraphemeOffset(value, clamped)
    : previousGraphemeOffset(value, clamped)
}
