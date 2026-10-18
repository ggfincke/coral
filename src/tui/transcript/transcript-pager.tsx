// src/tui/transcript/transcript-pager.tsx
// full-height transcript overlay with less-style paging and substring search

import { useEffect, useMemo, useRef, useState } from 'react'
import { LineList } from '../components/line-list.js'
import { useCoralInput } from '../input/use-coral-input.js'
import {
  buildPagerFooter,
  buildPagerTitle,
  findMatchRows,
  highlightRow,
  initialPagerState,
  maxPagerTop,
  plainRow,
  plainRowsFor,
  reducePagerInput,
  type PagerState,
} from './pager.js'
import {
  buildCommittedTranscript,
  buildLiveTranscript,
  type TranscriptOptions,
} from './transcript.js'

export interface TranscriptPagerProps
{
  transcript: Omit<TranscriptOptions, 'width' | 'forceExpanded'>
  width: number
  height: number
  active?: boolean
  onClose: () => void
  // ctrl+c inside the pager; the owner decides between stopping a run and closing
  onInterrupt: () => void
}

// title row plus footer row around the body
const CHROME_ROWS = 2

export default function TranscriptPager({
  transcript,
  width,
  height,
  active = true,
  onClose,
  onInterrupt,
}: TranscriptPagerProps)
{
  const bodyHeight = Math.max(height - CHROME_ROWS, 1)
  // tool outputs show in full here; the committed rows come from the shared
  // cache keyed by the blocks array, so ticks only re-render the live tail
  const committed = buildCommittedTranscript({
    ...transcript,
    width,
    forceExpanded: true,
  })
  const live = buildLiveTranscript(
    { ...transcript, width, forceExpanded: true },
    committed.blockCount
  )
  const rows = useMemo(
    () => [...committed.lines, ...live.lines],
    [committed.lines, live.lines]
  )
  const plain = useMemo(
    () => [...plainRowsFor(committed.lines), ...live.lines.map(plainRow)],
    [committed.lines, live.lines]
  )

  const [state, setState] = useState<PagerState>(() =>
    initialPagerState(rows.length, bodyHeight)
  )

  // follow the bottom only while already there; a reader who scrolled up keeps
  // their top row as the live tail grows (codex behavior). a width change
  // rewraps every row, so re-anchor by ratio and drop the stale match row
  const geometryRef = useRef({ total: rows.length, bodyHeight, width })
  useEffect(() =>
  {
    const previous = geometryRef.current
    geometryRef.current = { total: rows.length, bodyHeight, width }
    if (
      previous.total === rows.length &&
      previous.bodyHeight === bodyHeight &&
      previous.width === width
    )
      return
    setState((current) =>
    {
      const limit = maxPagerTop(rows.length, bodyHeight)
      if (previous.width !== width)
      {
        const ratio = previous.total > 0 ? current.top / previous.total : 0
        return {
          ...current,
          top: Math.min(Math.round(ratio * rows.length), limit),
          current: null,
        }
      }
      const wasAtBottom =
        current.top >= maxPagerTop(previous.total, previous.bodyHeight)
      return {
        ...current,
        top: wasAtBottom ? limit : Math.min(current.top, limit),
      }
    })
  }, [bodyHeight, rows.length, width])

  const matches = useMemo(
    () => findMatchRows(plain, state.query),
    [plain, state.query]
  )
  const matchRows = useMemo(() => new Set(matches), [matches])

  useCoralInput(
    (input, key) =>
    {
      const step = reducePagerInput(state, input, key, {
        total: rows.length,
        bodyHeight,
        matchesFor: (query) => findMatchRows(plain, query),
      })
      if (step.interrupt)
      {
        onInterrupt()
        return
      }
      if (step.close)
      {
        onClose()
        return
      }
      if (step.state !== state) setState(step.state)
    },
    { isActive: active }
  )

  // the visible slice is a handful of rows, so build it each render and let
  // the compiler decide what to memoize
  const top = Math.min(state.top, maxPagerTop(rows.length, bodyHeight))
  const body: string[] = []
  for (let row = top; row < top + bodyHeight; row++)
  {
    const line = rows[row]
    if (line === undefined)
    {
      body.push('')
      continue
    }
    body.push(
      matchRows.has(row)
        ? highlightRow(line, state.query, row === state.current)
        : line
    )
  }
  const lines = [
    buildPagerTitle(width),
    ...body,
    buildPagerFooter(state, { total: rows.length, bodyHeight }, matches, width),
  ]

  return <LineList lines={lines} />
}
