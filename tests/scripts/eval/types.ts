// tests/scripts/eval/types.ts
// shared type contract for the model eval harness

import type {
  OllamaMessage,
  ReliabilityStats,
} from '../../../src/types/inference.js'

// one benchmark case: seed a scratch dir, run the agent, then grade the result
export interface EvalTask
{
  id: string
  description: string
  prompt: string
  // seed the scratch dir before the agent runs
  setup(dir: string): Promise<void>
  grade(ctx: GradeContext): Promise<GradeResult>
}

// inputs a grader inspects: the scratch dir & the agent's transcript
export interface GradeContext
{
  dir: string
  messages: OllamaMessage[]
  finalText: string
}

export interface GradeResult
{
  passed: boolean
  detail: string
}

// per-run measurements captured around a single agent run
export interface RunMetrics
{
  // onToolResult callbacks fired during the run
  toolCallsExecuted: number
  // onToolResult callbacks whose error arg is defined
  toolErrors: number
  // agent.getReliabilityStats() captured AFTER run() resolves
  reliability: ReliabilityStats
  // (toolCallsExecuted + compensations === 0) ? 1 : 1 - compensations / (toolCallsExecuted + compensations)
  cleanlinessRate: number
  // last onUsage totalPromptTokens
  promptTokens: number
  // last onUsage totalCompletionTokens
  completionTokens: number
  // last onUsage: totalEvalDurationNs > 0 ? totalCompletionTokens / (totalEvalDurationNs / 1e9) : 0
  tokensPerSecond: number
  // wall time measured around run()
  wallMs: number
  aborted: boolean
  errored: boolean
}

// a single rep: metrics plus its pass/fail verdict
export interface RunOutcome extends RunMetrics
{
  passed: boolean
  detail: string
}

// one task aggregated across reps; metrics are the mean across reps
export interface TaskResult
{
  taskId: string
  reps: number
  passes: number
  passed: boolean
  detail: string
  metrics: RunMetrics
}

export interface ModelReport
{
  model: string
  results: TaskResult[]
  passRate: number
  meanCleanliness: number
  meanTokensPerSecond: number
}

export interface EvalReport
{
  models: ModelReport[]
  host: string
  reps: number
}

export interface EvalOptions
{
  host?: string
  reps?: number
  maxIterations?: number
  timeoutMs?: number
  think?: boolean | 'low' | 'medium' | 'high'
  // run only tasks whose id is in this list
  taskFilter?: string[]
  // fold each model's summed run reliability into ~/.coral/eval-telemetry.json
  saveTelemetry?: boolean
}
