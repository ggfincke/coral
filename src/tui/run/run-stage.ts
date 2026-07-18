// src/tui/run/run-stage.ts
// shared run-stage types and animation visibility checks

export type RunStage =
  | 'idle'
  | 'waiting'
  | 'thinking'
  | 'responding'
  | 'compacting'
  | `tool:${string}`

// show animation only when the UI displays a shimmer or spinner
export function isAnimatedRunStage(stage: RunStage): boolean
{
  return (
    stage === 'waiting' || stage === 'compacting' || stage.startsWith('tool:')
  )
}
