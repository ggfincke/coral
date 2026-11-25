// src/tui/palette/command-palette.tsx
// interactive command palette for slash commands and keybindings

import { useMemo } from 'react'
import {
  buildPaletteLines,
  filterPaletteEntries,
  reducePaletteInput,
  type PaletteEntry,
} from './palette.js'
import { useCoralInput } from '../input/use-coral-input.js'
import { useLiveState } from '../input/use-live-state.js'
import { appendDraftInput } from '../prompt/grapheme.js'
import type { CoralKey } from '../input/terminal-input.js'
import { LineList } from '../components/line-list.js'

export interface CommandPaletteProps
{
  entries: PaletteEntry[]
  width: number
  height: number
  active?: boolean
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
  active = true,
  onSelect,
  onClose,
}: CommandPaletteProps)
{
  const [filter, filterRef, setFilter] = useLiveState({
    query: '',
    selectedIndex: 0,
  })
  const { query, selectedIndex } = filter
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

  useCoralInput(
    (input, key) =>
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
      // keys earlier in the same stdin read may have changed the filter
      const live = filterRef.current
      const liveMatches =
        live === filter ? matches : filterPaletteEntries(entries, live.query)
      const liveIndex = Math.min(
        live.selectedIndex,
        Math.max(liveMatches.length - 1, 0)
      )
      if (key.return)
      {
        const selected = liveMatches[liveIndex]
        if (selected?.command || selected?.action)
        {
          onSelect(selected)
        }
        return
      }

      const next = reducePaletteInput(
        { query: live.query, selectedIndex: liveIndex },
        input,
        key,
        liveMatches.length
      )
      if (next.handled) setFilter(next.state)
    },
    {
      isActive: active,
      onPaste: (text) =>
        setFilter((live) => ({
          query: appendDraftInput(live.query, text),
          selectedIndex: 0,
        })),
    }
  )

  return <LineList lines={lines} />
}
