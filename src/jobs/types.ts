// src/jobs/types.ts
// durable task values shared by the worker, supervisor, and clients

// the persisted status and phase vocabularies; record validation and the
// supervisor derive their sets from these lists
export const JOB_STATUSES = [
  'draft',
  'queued',
  'running',
  'ready_for_review',
  'needs_input',
  'interrupted',
  'cancelled',
  'failed',
] as const

export type JobStatus = (typeof JOB_STATUSES)[number]

// statuses a worker can settle into; these are also the resumable ones
export const SETTLED_JOB_STATUSES = [
  'ready_for_review',
  'needs_input',
  'interrupted',
  'cancelled',
  'failed',
] as const satisfies readonly JobStatus[]

export type SettledJobStatus = (typeof SETTLED_JOB_STATUSES)[number]

export const JOB_PHASES = [
  'setup',
  'implement',
  'checks',
  'repair',
  'reconcile',
] as const

export type JobPhase = (typeof JOB_PHASES)[number]

export interface JobRepository
{
  source: string
  commonDir: string
  commit: string
}

export interface JobSpec
{
  objective: string
  model: string
  host: string
  repository: JobRepository
  plan: string
  setup: string[]
  checks: string[]
  activeTimeLimitMs: number
  maxRepairs: number
}

export interface JobCommandResult
{
  phase: 'setup' | 'checks'
  command: string
  attempt: number
  ok: boolean
  // bounded tail; longer output lives in the task's outputFile
  output: string
  outputFile?: string
  startedAt: string
  finishedAt: string
}

export interface JobRecord
{
  version: 1
  id: string
  createdAt: string
  updatedAt: string
  status: JobStatus
  settledStatus?: SettledJobStatus
  spec: JobSpec
  approval?: { digest: string; approvedAt: string; hostShell: true }
  queuedAt?: string
  queueOrder?: number
  // pending marks a creation that has not been verified yet, so a crash
  // mid-creation can be rebuilt without touching task work
  worktree?: { path: string; branch: string; pending?: true }
  phase?: JobPhase
  activeSince?: string
  consumedMs: number
  repairs: number
  snapshot?: string
  continuation?: string
  resumeSetup?: 'retry' | 'skip'
  resumeShell?: 'continue' | 'retry'
  unsettledShells?: {
    command: string
    startedAt: string
    result?: { ok: boolean; output: string }
  }[]
  commandResults: JobCommandResult[]
  setupCompleted?: number
  pendingCommand?: {
    phase: 'setup' | 'checks'
    command: string
    index: number
    attempt: number
  }
  summary?: string
  error?: string
}

// the supervisor cancels a running task by stopping its worker and settles
// any other status listed here directly
const CANCELLABLE_JOB_STATUSES: readonly JobStatus[] = [
  'draft',
  'queued',
  'running',
  'interrupted',
  'needs_input',
]

export function canCancelJob(job: Pick<JobRecord, 'status'>): boolean
{
  return CANCELLABLE_JOB_STATUSES.includes(job.status)
}

// status rule only; continuing also needs an approval matching the spec
export function canContinueJob(job: Pick<JobRecord, 'status'>): boolean
{
  return (SETTLED_JOB_STATUSES as readonly JobStatus[]).includes(job.status)
}

// agent shell commands whose effects are unknown; continuing needs a decision
export function unsettledShellCommands(
  job: Pick<JobRecord, 'unsettledShells'>
): string[]
{
  return (job.unsettledShells ?? [])
    .filter((shell) => !shell.result)
    .map((shell) => shell.command)
}

export interface JobEvent
{
  sequence: number
  at: string
  type: string
  text: string
}

export interface JobPlanOptions
{
  cwd: string
  ref?: string
  objective: string
  model: string
  host: string
  activeTimeLimitMs?: number
  maxRepairs?: number
}

export type JobRequest =
  | { action: 'ping' }
  | { action: 'edit'; id: string; digest: string; spec: JobSpec }
  | {
      action: 'start'
      id: string
      digest: string
      hostShell: true
      // filled by the client: tasks run with the approving shell's environment
      environment?: Record<string, string>
    }
  | { action: 'cancel'; id: string }
  | {
      action: 'resume'
      id: string
      instructions: string
      setupResolution?: 'retry' | 'skip'
      shellResolution?: 'continue' | 'retry'
      environment?: Record<string, string>
    }

export interface JobResponse
{
  ok: boolean
  error?: string
  job?: JobRecord
}

export const DEFAULT_JOB_ACTIVE_MS = 2 * 60 * 60 * 1000
export const DEFAULT_JOB_REPAIRS = 3
