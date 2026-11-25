// src/tui/input/use-live-state.ts
// render state that key handlers can read before the next render commits

import { useCallback, useRef, useState, type RefObject } from 'react'

export type LiveStateUpdate<T> = T | ((current: T) => T)

// Ink hands every key of one stdin read to the handler before React renders,
// so handlers reduce from `ref.current`, which each write updates at once;
// the state copy only drives rendering
export function useLiveState<T>(
  initial: T | (() => T)
): [T, RefObject<T>, (update: LiveStateUpdate<T>) => void]
{
  const [state, setState] = useState(initial)
  const ref = useRef(state)
  const set = useCallback((update: LiveStateUpdate<T>) =>
  {
    const next =
      typeof update === 'function'
        ? (update as (current: T) => T)(ref.current)
        : update
    ref.current = next
    setState(next)
  }, [])

  return [state, ref, set]
}
