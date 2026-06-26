// src/tools/subagent.ts
// process-global fallback subagent runner — the task tool prefers its ToolContext
// runner, falling back here when run outside an agent (avoids a tools<->agent cycle)

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

// set the fallback runner for the task tool when it runs without a ToolContext
// runner (e.g. direct taskTool.execute() in tests); agents inject via ToolContext
export function setSubagentRunner(runner: SubagentRunner | null): void
{
  activeRunner = runner
}

export function getSubagentRunner(): SubagentRunner | null
{
  return activeRunner
}
