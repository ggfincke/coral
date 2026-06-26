// src/tui/hooks/clear-timer-ref.ts
// clear a React timer ref & null it out

import type { MutableRefObject } from 'react'

// clearTimeout also cancels setInterval handles in Node
export function clearTimerRef(
  ref: MutableRefObject<ReturnType<typeof setTimeout> | null>
): void
{
  if (ref.current)
  {
    clearTimeout(ref.current)
    ref.current = null
  }
}
