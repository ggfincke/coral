// src/tools/subagent.ts
// fallback subagent runner for task calls outside an Agent context

// keep the fallback seam outside the Agent to avoid a tools-to-agent cycle

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

// set the fallback runner for task calls without a ToolContext runner
export function setSubagentRunner(runner: SubagentRunner | null): void
{
  activeRunner = runner
}

export function getSubagentRunner(): SubagentRunner | null
{
  return activeRunner
}
