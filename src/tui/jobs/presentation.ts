// src/tui/jobs/presentation.ts
// present durable task records using existing terminal styles and renderers

import type { JobEvent, JobRecord } from '../../jobs/types.js'
import type { SessionData } from '../../session/types.js'
import { sanitizeUntrustedText } from '../../utils/untrusted-text.js'
import { style } from '../theme.js'
import { renderUnifiedDiff } from '../transcript/diff.js'
import { buildRestoredBlocks } from '../transcript/restored-blocks.js'
import { buildTranscriptLines } from '../transcript/transcript.js'
import { physicalLines } from '../wrap.js'

export const JOB_TABS = [
  'overview',
  'transcript',
  'events',
  'checks',
  'diff',
] as const
export type JobTab = (typeof JOB_TABS)[number]

export function jobDuration(milliseconds: number): string
{
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function orderJobs(jobs: JobRecord[]): JobRecord[]
{
  const rank = (job: JobRecord) =>
    job.status === 'running' ? 0 : job.status === 'queued' ? 1 : 2
  return [...jobs].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.status === 'queued' && b.status === 'queued'
        ? (a.queueOrder ?? 0) - (b.queueOrder ?? 0)
        : b.createdAt.localeCompare(a.createdAt)) ||
      a.id.localeCompare(b.id)
  )
}

function commandLines(title: string, commands: string[]): string[]
{
  return [
    style('accent').bold(title),
    ...(commands.length
      ? commands.map(
          (command, index) => `${index + 1}. ${sanitizeUntrustedText(command)}`
        )
      : ['(none)']),
    '',
  ]
}

export function jobOverview(job: JobRecord, now: number): string[]
{
  const consumed =
    job.consumedMs +
    (job.activeSince ? Math.max(0, now - Date.parse(job.activeSince)) : 0)
  const lines = [
    style('accent').bold('Objective'),
    sanitizeUntrustedText(job.spec.objective),
    '',
    `Repository: ${sanitizeUntrustedText(job.spec.repository.source)}`,
    `Pinned commit: ${job.spec.repository.commit}`,
    `Model: ${sanitizeUntrustedText(job.spec.model)}`,
    `Ollama host: ${sanitizeUntrustedText(job.spec.host)}`,
    `Active time: ${jobDuration(consumed)} / ${jobDuration(job.spec.activeTimeLimitMs)}`,
    `Repair attempts: ${job.repairs} / ${job.spec.maxRepairs}`,
    `Worktree: ${job.worktree ? sanitizeUntrustedText(job.worktree.path) : '(created after start)'}`,
    ...(job.worktree ? [`Branch: ${job.worktree.branch}`] : []),
    '',
    style('accent').bold('Plan'),
    sanitizeUntrustedText(job.spec.plan),
    '',
    ...commandLines('Setup commands', job.spec.setup),
    ...commandLines('Verification commands', job.spec.checks),
  ]
  if (job.pendingCommand)
    lines.push(
      style('warning')(
        'Unsettled command; inspect its effects before continuation:'
      ),
      sanitizeUntrustedText(job.pendingCommand.command),
      ''
    )
  if (job.unsettledShells?.some((shell) => !shell.result))
    lines.push(
      style('warning')(
        'Agent shell commands with uncertain results; inspect their effects before continuation:'
      ),
      ...job.unsettledShells
        .filter((shell) => !shell.result)
        .map((shell) => sanitizeUntrustedText(shell.command)),
      ''
    )
  if (job.summary)
    lines.push(
      style('accent').bold('Summary'),
      sanitizeUntrustedText(job.summary),
      ''
    )
  if (job.error)
    lines.push(
      style('error')('Task needs attention'),
      sanitizeUntrustedText(job.error),
      ''
    )
  if (job.status === 'draft')
    lines.push(
      'Review the pinned commit, plan, commands, and limits. Edit the JSON draft with e before acknowledging host execution.'
    )
  else if (job.status === 'ready_for_review')
    lines.push(
      'Review the preserved worktree and check evidence. Changes have not been applied or published.'
    )
  return lines
}

export function jobDetailLines(
  job: JobRecord,
  tab: JobTab,
  width: number,
  now: number,
  events: JobEvent[],
  snapshot: SessionData | undefined,
  diff: string
): string[]
{
  let lines: string[]
  if (tab === 'transcript')
  {
    lines = snapshot
      ? [
          style('muted')(
            'Last settled checkpoint. The events tab shows live execution.'
          ),
          '',
          ...buildTranscriptLines({
            cwd: job.worktree?.path,
            blocks: buildRestoredBlocks(snapshot.messages),
            streaming: '',
            width,
          }),
        ]
      : [
          'No settled conversation checkpoint yet. Open events for live progress.',
        ]
  }
  else if (tab === 'events')
    lines = events.length
      ? events.flatMap((event) => [
          style('muted')(
            `${event.sequence} · ${event.at} · ${sanitizeUntrustedText(event.type)}`
          ),
          sanitizeUntrustedText(event.text),
          '',
        ])
      : ['No task events yet.']
  else if (tab === 'checks')
    lines = job.commandResults.length
      ? job.commandResults.flatMap((result) => [
          style(result.ok ? 'success' : 'error')(
            `${result.ok ? 'PASS' : 'FAIL'} · ${result.phase} · attempt ${result.attempt}`
          ),
          sanitizeUntrustedText(result.command),
          style('muted')(`${result.startedAt} -> ${result.finishedAt}`),
          sanitizeUntrustedText(result.output || '(no output)'),
          '',
        ])
      : ['No settled command results yet.']
  else if (tab === 'diff')
    lines = renderUnifiedDiff(
      diff || 'Loading staged, unstaged, and untracked changes…',
      width
    )
  else lines = jobOverview(job, now)
  return physicalLines(lines, width)
}
