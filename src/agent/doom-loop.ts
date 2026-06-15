// src/agent/doom-loop.ts
// detect a stuck agent loop — same tool+args or same error repeated

// repeats within the window before a trip fires
export const DEFAULT_DOOM_LOOP_THRESHOLD = 3
// recent calls considered when counting repeats
export const DEFAULT_DOOM_LOOP_WINDOW = 12

export interface DoomLoopConfig
{
  threshold: number
  window: number
}

export const DEFAULT_DOOM_LOOP_CONFIG: DoomLoopConfig = {
  threshold: DEFAULT_DOOM_LOOP_THRESHOLD,
  window: DEFAULT_DOOM_LOOP_WINDOW,
}

// why the loop tripped — a repeated identical call, or a repeated identical error
export interface DoomLoopTrip
{
  kind: 'repeat-call' | 'repeat-error'
  // tool name (repeat-call) or a short error excerpt (repeat-error)
  detail: string
  count: number
}

interface CallRecord
{
  signature: string
  error: string
}

// * tracks recent tool calls & flags a stuck loop
export class DoomLoopDetector
{
  private records: CallRecord[] = []
  private readonly threshold: number
  private readonly window: number

  constructor(config: DoomLoopConfig = DEFAULT_DOOM_LOOP_CONFIG)
  {
    this.threshold = config.threshold
    this.window = config.window
  }

  // record an executed call & its result error; returns a trip when the recent
  // window shows the same call or the same error repeated past the threshold
  record(
    toolName: string,
    args: Record<string, unknown>,
    error?: string
  ): DoomLoopTrip | null
  {
    const signature = `${toolName}:${stableStringify(args)}`
    const errorText = error?.trim() ?? ''
    this.records.push({ signature, error: errorText })
    if (this.records.length > this.window) this.records.shift()

    const sameCall = this.records.filter(
      (r) => r.signature === signature
    ).length
    if (sameCall >= this.threshold)
    {
      return { kind: 'repeat-call', detail: toolName, count: sameCall }
    }

    if (errorText)
    {
      const sameError = this.records.filter((r) => r.error === errorText).length
      if (sameError >= this.threshold)
      {
        return {
          kind: 'repeat-error',
          detail: excerpt(errorText),
          count: sameError,
        }
      }
    }

    return null
  }

  // clear the window after the user opts to continue, so a fresh streak is
  // required before tripping again
  reset(): void
  {
    this.records = []
  }
}

// human-readable description of a trip for the pause prompt
export function describeDoomLoop(trip: DoomLoopTrip): string
{
  if (trip.kind === 'repeat-call')
  {
    return `Coral called ${trip.detail} with identical arguments ${trip.count} times.`
  }
  return `Coral hit the same error ${trip.count} times: ${trip.detail}`
}

// short single-line excerpt of an error for the trip message
function excerpt(text: string): string
{
  const firstLine = text.split('\n')[0]!.trim()
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
}

// deterministic JSON w/ sorted keys so {a,b} & {b,a} share a signature
function stableStringify(value: unknown): string
{
  if (value === null || typeof value !== 'object')
  {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value))
  {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const entries = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
  return `{${entries.join(',')}}`
}
