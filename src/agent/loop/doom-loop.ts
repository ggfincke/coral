// src/agent/loop/doom-loop.ts
// repeated tool-call and error detection

import { excerpt } from '../../utils/ellipsize.js'

// repeated observations required before a trip fires
const DEFAULT_DOOM_LOOP_THRESHOLD = 3
// recent calls considered for repeat detection
const DEFAULT_DOOM_LOOP_WINDOW = 12

export interface DoomLoopConfig
{
  threshold: number
  window: number
}

const DEFAULT_DOOM_LOOP_CONFIG: DoomLoopConfig = {
  threshold: DEFAULT_DOOM_LOOP_THRESHOLD,
  window: DEFAULT_DOOM_LOOP_WINDOW,
}

// reason the loop tripped
export interface DoomLoopTrip
{
  kind: 'repeat-call' | 'repeat-error'
  // tool name for repeat-call or error excerpt for repeat-error
  detail: string
  count: number
}

interface CallRecord
{
  signature: string
  error: string
}

// * Track recent tool calls and flag a stuck loop
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

  // record a call and return a trip when the recent window repeats it
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
          detail: excerpt(errorText, 80),
          count: sameError,
        }
      }
    }

    return null
  }

  // require a fresh streak after the user chooses to continue
  reset(): void
  {
    this.records = []
  }
}

// format a trip for the pause prompt
export function describeDoomLoop(trip: DoomLoopTrip): string
{
  if (trip.kind === 'repeat-call')
  {
    return `Coral called ${trip.detail} with identical arguments ${trip.count} times.`
  }
  return `Coral hit the same error ${trip.count} times: ${trip.detail}`
}

// serialize arguments with sorted keys so object order does not change signatures
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
