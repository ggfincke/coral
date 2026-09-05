// src/tui/transcript/backtrack-selector.tsx
// overlay listing prior user prompts for esc-esc rewind

import { useMemo, useState } from 'react'
import {
  buildBacktrackLines,
  reduceBacktrackInput,
  type BacktrackTurn,
} from './backtrack.js'
import { useCoralInput } from '../input/use-coral-input.js'
import type { CoralKey } from '../input/terminal-input.js'
import { LineList } from '../components/line-list.js'

export interface BacktrackSelectorProps
{
  turns: BacktrackTurn[]
  width: number
  height: number
  onSelect: (turn: BacktrackTurn) => void
  onClose: () => void
}

function isCtrlLetter(input: string, key: CoralKey, letter: string): boolean
{
  return key.ctrl && input.toLowerCase() === letter
}

export default function BacktrackSelector({
  turns,
  width,
  height,
  onSelect,
  onClose,
}: BacktrackSelectorProps)
{
  // newest prompt preselected; backtracks usually target recent turns
  const [selectedIndex, setSelectedIndex] = useState(
    Math.max(turns.length - 1, 0)
  )
  const safeIndex = Math.min(selectedIndex, Math.max(turns.length - 1, 0))
  const lines = useMemo(
    () =>
      buildBacktrackLines({
        turns,
        selectedIndex: safeIndex,
        width,
        height,
      }),
    [height, safeIndex, turns, width]
  )

  useCoralInput((input, key) =>
  {
    if (key.escape || isCtrlLetter(input, key, 'c'))
    {
      onClose()
      return
    }
    if (key.return)
    {
      const selected = turns[safeIndex]
      if (selected) onSelect(selected)
      return
    }

    const next = reduceBacktrackInput(
      { selectedIndex: safeIndex },
      key,
      turns.length
    )
    if (next.handled)
    {
      setSelectedIndex(next.state.selectedIndex)
    }
  })

  return <LineList lines={lines} />
}
