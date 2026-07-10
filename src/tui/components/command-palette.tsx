// src/tui/components/command-palette.tsx
// interactive command palette for slash commands & keybindings

import { useMemo, useState } from 'react'
import {
  buildPaletteLines,
  filterPaletteEntries,
  reducePaletteInput,
  type PaletteEntry,
} from '../palette.js'
import { useCoralInput, type CoralKey } from '../hooks/use-coral-input.js'
import { LineList } from './line-list.js'

export interface CommandPaletteProps
{
  entries: PaletteEntry[]
  width: number
  height: number
  onSelect: (entry: PaletteEntry) => void
  onClose: () => void
}

function isCtrlLetter(input: string, key: CoralKey, letter: string): boolean
{
  return key.ctrl && input.toLowerCase() === letter
}

export default function CommandPalette({
  entries,
  width,
  height,
  onSelect,
  onClose,
}: CommandPaletteProps)
{
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const matches = useMemo(
    () => filterPaletteEntries(entries, query),
    [entries, query]
  )
  const safeIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0))
  const lines = useMemo(
    () =>
      buildPaletteLines({
        entries: matches,
        query,
        selectedIndex: safeIndex,
        width,
        height,
      }),
    [height, matches, query, safeIndex, width]
  )

  useCoralInput((input, key) =>
  {
    if (
      key.escape ||
      isCtrlLetter(input, key, 'c') ||
      isCtrlLetter(input, key, 'p')
    )
    {
      onClose()
      return
    }
    if (key.return)
    {
      const selected = matches[safeIndex]
      if (selected?.command || selected?.action)
      {
        onSelect(selected)
      }
      return
    }

    const next = reducePaletteInput(
      { query, selectedIndex: safeIndex },
      input,
      key,
      matches.length
    )
    if (next.handled)
    {
      setQuery(next.state.query)
      setSelectedIndex(next.state.selectedIndex)
    }
  })

  return <LineList lines={lines} />
}
