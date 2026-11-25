// src/tui/transcript/backtrack-selector.tsx
// overlay listing prior user prompts for esc-esc rewind

import { useMemo } from 'react'
import {
  buildBacktrackLines,
  reduceBacktrackInput,
  type BacktrackTurn,
} from './backtrack.js'
import { useCoralInput } from '../input/use-coral-input.js'
import { useLiveState } from '../input/use-live-state.js'
import type { CoralKey } from '../input/terminal-input.js'
import { LineList } from '../components/line-list.js'

export interface BacktrackSelectorProps
{
  turns: BacktrackTurn[]
  width: number
  height: number
  active?: boolean
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
  active = true,
  onSelect,
  onClose,
}: BacktrackSelectorProps)
{
  // newest prompt preselected; backtracks usually target recent turns
  const [selectedIndex, selectedIndexRef, setSelectedIndex] = useLiveState(
    Math.max(turns.length - 1, 0)
  )
  const clampIndex = (index: number) =>
    Math.min(index, Math.max(turns.length - 1, 0))
  const safeIndex = clampIndex(selectedIndex)
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

  useCoralInput(
    (input, key) =>
    {
      if (key.escape || isCtrlLetter(input, key, 'c'))
      {
        onClose()
        return
      }
      // keys earlier in the same stdin read may have moved the selection
      const liveIndex = clampIndex(selectedIndexRef.current)
      if (key.return)
      {
        const selected = turns[liveIndex]
        if (selected) onSelect(selected)
        return
      }

      const next = reduceBacktrackInput(
        { selectedIndex: liveIndex },
        key,
        turns.length
      )
      if (next.handled)
      {
        setSelectedIndex(next.state.selectedIndex)
      }
    },
    { isActive: active }
  )

  return <LineList lines={lines} />
}
