// src/tui/shell/shutdown.ts
// coordinate signal-driven shutdown for the TUI

// SIGHUP arrives when the terminal tab closes or an ssh session drops
type ShutdownSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'

const SHUTDOWN_SIGNALS: readonly ShutdownSignal[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
]

// stream errors a closed terminal raises on the final render or stdin read
const CLOSED_TERMINAL_CODES = new Set(['EIO', 'EPIPE'])

type StreamErrorListener = (error: NodeJS.ErrnoException) => void

interface StreamLike
{
  on(event: 'error', listener: StreamErrorListener): unknown
  off(event: 'error', listener: StreamErrorListener): unknown
  listenerCount(event: 'error'): number
}

export interface SignalProcessLike
{
  once(event: ShutdownSignal, listener: () => void): unknown
  off?(event: ShutdownSignal, listener: () => void): unknown
  stdout?: StreamLike
  stdin?: StreamLike
}

// a hung-up terminal fails stdout writes & stdin reads with EIO/EPIPE, maybe
// before SIGHUP lands; dropping those keeps the process alive for cleanup,
// while any other error still crashes as it would with no listener
function closedTerminalFilter(stream: StreamLike): StreamErrorListener
{
  return (error) =>
  {
    if (CLOSED_TERMINAL_CODES.has(error.code ?? '')) return
    if (stream.listenerCount('error') === 1) throw error
  }
}

// register process signal handlers and return an unregister callback
export function registerSignalHandlers(
  proc: SignalProcessLike,
  handler: () => void
): () => void
{
  for (const signal of SHUTDOWN_SIGNALS) proc.once(signal, handler)
  const filters = [proc.stdout, proc.stdin]
    .filter((stream) => stream !== undefined)
    .map((stream) => [stream, closedTerminalFilter(stream)] as const)
  for (const [stream, filter] of filters) stream.on('error', filter)

  return () =>
  {
    for (const signal of SHUTDOWN_SIGNALS) proc.off?.(signal, handler)
    for (const [stream, filter] of filters) stream.off('error', filter)
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
