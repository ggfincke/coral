// src/tui/shell/shutdown.ts
// coordinate signal-driven shutdown for the TUI

export interface SignalProcessLike
{
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off?(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

// register process signal handlers & return an unregister callback
export function registerSignalHandlers(
  proc: SignalProcessLike,
  handler: () => void
): () => void
{
  proc.once('SIGINT', handler)
  proc.once('SIGTERM', handler)

  return () =>
  {
    proc.off?.('SIGINT', handler)
    proc.off?.('SIGTERM', handler)
  }
}

// ensure shutdown cleanup only runs once even if multiple signals arrive
export function createShutdownCoordinator(
  cleanup: () => Promise<void> | void,
  exit: () => void
): () => Promise<void>
{
  let inFlight: Promise<void> | null = null

  return async () =>
  {
    if (inFlight) return inFlight

    inFlight = (async () =>
    {
      try
      {
        await cleanup()
      }
      finally
      {
        exit()
      }
    })()

    return inFlight
  }
}
