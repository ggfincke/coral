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
  // first round's prompt tokens: the system prompt plus task prompt cost
  firstRoundPromptTokens: number
  aborted: boolean
  errored: boolean
}

// a single rep: metrics plus its pass/fail verdict
export interface RunOutcome extends RunMetrics
{
  rounds: RoundSample[]
  passed: boolean
  detail: string
}

export interface RoundSample
{
  round: number
  promptTokens: number
  completionTokens: number
  contextTokens: number
  promptEvalDurationNs: number | null
  evalDurationNs: number | null
  doneReason: string | null
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
  runs: RunOutcome[]
}

export interface ModelReport
{
  model: string
  results: TaskResult[]
  passRate: number
  meanCleanliness: number
  meanTokensPerSecond: number
  // median across tasks of each task's median first-round prompt tokens
  firstRoundPromptTokens: number
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
  // pinned (default) sends temperature 0 and seed = rep index so reps differ
  // only by what changed under test; model leaves Ollama's own sampling in place
  sampling?: 'pinned' | 'model'
  // run only tasks whose id is in this list
  taskFilter?: string[]
  // append each model's summed run reliability under ~/.coral/eval-telemetry.d
  saveTelemetry?: boolean
}
