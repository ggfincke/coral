// src/tools/subagent.ts
// runtime holder for the subagent runner injected by the agent layer —
// tools can't import Agent directly w/o a tools<->agent import cycle

export interface SubagentResult
{
  text: string
  error?: string
  aborted?: boolean
}

export type SubagentRunner = (
  prompt: string,
  signal?: AbortSignal
) => Promise<SubagentResult>

let activeRunner: SubagentRunner | null = null

// the main agent registers its runner here; the task tool reads it
export function setSubagentRunner(runner: SubagentRunner | null): void
{
  activeRunner = runner
}

export function getSubagentRunner(): SubagentRunner | null
{
  return activeRunner
}
