// src/cli/jobs.ts
// dispatch durable coding task commands and private process entrypoints

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from 'commander'
import { controlJob } from '../jobs/client.js'
import { runJobService } from '../jobs/entry.js'
import { getJobDiff } from '../jobs/git.js'
import { createJobPlan } from '../jobs/plan.js'
import { assertJobsPlatform } from '../jobs/process.js'
import {
  jobCommandOutputPath,
  jobDirectory,
  jobSpecDigest,
  listJobRecords,
  readJob,
  readJobEvents,
  readJobSnapshot,
} from '../jobs/store.js'
import type { JobRecord } from '../jobs/types.js'
import { DEFAULT_OLLAMA_HOST } from '../ollama/host.js'
import { toErrorMessage } from '../utils/errors.js'
import { sanitizeUntrustedText } from '../utils/untrusted-text.js'

function output(text: string): void
{
  process.stdout.write(`${sanitizeUntrustedText(text)}\n`)
}

function json(value: unknown): void
{
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function integer(value: string): number
{
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
    throw new InvalidArgumentError('Use a nonnegative whole number.')
  return parsed
}

function minutes(value: string): number
{
  const parsed = Number(value)
  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    !Number.isSafeInteger(parsed * 60_000) ||
    parsed * 60_000 > 2_147_482_000
  )
    throw new InvalidArgumentError(
      'Use positive minutes with millisecond precision, at most 2147482000 milliseconds total.'
    )
  return parsed
}

function describe(job: JobRecord, transcript = false): void
{
  output(`Task ${job.id}: ${job.status}${job.phase ? ` (${job.phase})` : ''}`)
  output(
    `Active time recorded: ${(job.consumedMs / 60_000).toFixed(2)} / ${job.spec.activeTimeLimitMs / 60_000} minutes; repairs: ${job.repairs} / ${job.spec.maxRepairs}`
  )
  if (job.worktree)
    output(`Worktree: ${job.worktree.path}\nBranch: ${job.worktree.branch}`)
  if (job.error) output(`Attention: ${job.error}`)
  if (job.summary) output(`Summary:\n${job.summary}`)
  output(`Exact specification:\n${JSON.stringify(job.spec, null, 2)}`)
  output(`Specification digest: ${jobSpecDigest(job.spec)}`)
  if (job.status === 'draft')
  {
    output(`Edit the spec in: ${join(jobDirectory(job.id), 'job.json')}`)
    output(
      `After editing, run coral jobs show ${job.id} to review the updated specification and digest.`
    )
    output(
      'Setup, verification, and Agent shell commands run on this host. The worktree is not a sandbox.'
    )
    output(
      `Approve this exact draft: coral jobs start ${job.id} --approve ${jobSpecDigest(job.spec)} --allow-host-shell`
    )
  }
  if (job.pendingCommand)
    output(`Unsettled command:\n${JSON.stringify(job.pendingCommand, null, 2)}`)
  if (job.unsettledShells?.length)
    output(
      `Shell execution since the last settled task turn:\n${JSON.stringify(job.unsettledShells, null, 2)}`
    )
  if (job.commandResults.length)
  {
    output('Command results:')
    for (const result of job.commandResults)
      output(
        `[${result.phase}, attempt ${result.attempt}, ${result.ok ? 'pass' : 'fail'}] ${result.command}\n${result.output}` +
          (result.outputFile
            ? `\nFull output: ${jobCommandOutputPath(job.id, result.outputFile)}`
            : '')
      )
  }
  if (transcript)
  {
    if (!job.snapshot)
      output(
        'No settled conversation checkpoint yet. Use logs to inspect current progress.'
      )
    else
    {
      const snapshot = readJobSnapshot(job.id, job.snapshot)
      output('Last settled conversation:')
      for (const message of snapshot.messages)
      {
        output(
          `[${message.role}${message.tool_name ? `: ${message.tool_name}` : ''}]\n${message.content}`
        )
        if (message.thinking) output(`[thinking]\n${message.thinking}`)
        if (message.tool_calls?.length)
          output(JSON.stringify(message.tool_calls, null, 2))
      }
    }
  }
}

async function objectiveFromInput(
  value?: string,
  path?: string
): Promise<string>
{
  if (value !== undefined && path !== undefined)
    throw new Error('Provide an objective argument or --prompt-file, not both.')
  if (path !== undefined)
  {
    const contents = await readFile(resolve(path))
    if (contents.byteLength > 128 * 1024)
      throw new Error('Objective file exceeds 128 KiB.')
    value = contents.toString('utf8')
  }
  if (!value?.trim()) throw new Error('Provide a nonempty task objective.')
  return value.trim()
}

async function followLogs(
  id: string,
  options: { after: number; follow?: boolean; json?: boolean },
  signal: AbortSignal
): Promise<void>
{
  readJob(id)
  let cursor = options.after
  do
  {
    signal.throwIfAborted()
    // settlement events are appended before the status, so reading the
    // status first guarantees the final event is in this batch
    const settled =
      options.follow && !['queued', 'running'].includes(readJob(id).status)
    for (const event of readJobEvents(id, cursor))
    {
      if (options.json) process.stdout.write(`${JSON.stringify(event)}\n`)
      else
        output(`[${event.at} #${event.sequence} ${event.type}] ${event.text}`)
      cursor = event.sequence
    }
    if (!options.follow || settled) break
    await delay(250, undefined, { signal })
  } while (!signal.aborted)
}

export async function runJobsCli(args: string[]): Promise<number>
{
  // internal commands stay outside commander help and retain parent-owned service lifetimes
  if (args[0] === '_supervise' || args[0] === '_worker')
  {
    try
    {
      await runJobService(args[0], args[1])
      return 0
    }
    catch (error)
    {
      process.stderr.write(`${sanitizeUntrustedText(toErrorMessage(error))}\n`)
      return 1
    }
  }

  const abort = new AbortController()
  let interruptedBy: 'SIGINT' | 'SIGTERM' | undefined
  const interrupt = () =>
  {
    interruptedBy = 'SIGINT'
    abort.abort()
  }
  const terminate = () =>
  {
    interruptedBy = 'SIGTERM'
    abort.abort()
  }
  const command = new Command()
    .name('coral jobs')
    .description(
      'Prepare, run, and review persistent coding tasks in dedicated Git worktrees'
    )
    .exitOverride()
    .configureOutput({
      writeErr: (text) => process.stderr.write(sanitizeUntrustedText(text)),
    })
    .hook('preAction', () => assertJobsPlatform())

  command
    .command('plan [objective]')
    .description(
      'Inspect committed code and save an editable proposal without executing it'
    )
    .requiredOption('-m, --model <model>', 'Ollama model to use')
    .option('--prompt-file <path>', 'read the objective from a UTF-8 file')
    .option('--cwd <path>', 'source Git checkout', process.cwd())
    .option(
      '--ref <commit>',
      'committed starting point; explicitly use HEAD to exclude dirty changes'
    )
    .option('--host <url>', 'Ollama host URL', DEFAULT_OLLAMA_HOST)
    .option(
      '--time-limit <minutes>',
      'active execution budget in minutes',
      minutes,
      120
    )
    .option(
      '--max-repairs <count>',
      'automatic repair attempt budget',
      integer,
      3
    )
    .option(
      '--json',
      'print the draft, its path, and specification digest as JSON'
    )
    .action(
      async (
        objective: string | undefined,
        options: {
          model: string
          promptFile?: string
          cwd: string
          ref?: string
          host: string
          timeLimit: number
          maxRepairs: number
          json?: boolean
        }
      ) =>
      {
        if (!options.json)
          process.stderr.write(
            'Inspecting the selected commit and preparing an editable task draft…\n'
          )
        const job = await createJobPlan(
          {
            objective: await objectiveFromInput(objective, options.promptFile),
            cwd: resolve(options.cwd),
            ref: options.ref,
            model: options.model,
            host: options.host,
            activeTimeLimitMs: options.timeLimit * 60_000,
            maxRepairs: options.maxRepairs,
          },
          {},
          abort.signal
        )
        if (options.json)
          json({
            job,
            digest: jobSpecDigest(job.spec),
            draftPath: join(jobDirectory(job.id), 'job.json'),
          })
        else describe(job)
      }
    )

  command
    .command('start <id>')
    .description(
      'Approve an exact reviewed draft and add it to the background queue'
    )
    .requiredOption(
      '--approve <digest>',
      'specification digest printed by plan or show'
    )
    .option(
      '--allow-host-shell',
      'acknowledge that all task shell commands run on this host'
    )
    .option('--json', 'print the accepted task as JSON')
    .action(
      async (
        id: string,
        options: { approve: string; allowHostShell?: boolean; json?: boolean }
      ) =>
      {
        if (!options.allowHostShell)
          throw new Error(
            'Starting requires --allow-host-shell: setup, checks, and Agent shell commands execute on this host; worktrees are not sandboxes.'
          )
        const draft = readJob(id)
        if (draft.status !== 'draft')
          throw new Error('Only a draft task can be started.')
        if (options.approve !== jobSpecDigest(draft.spec))
          throw new Error(
            'The draft differs from the approved digest. Run jobs show and review its current specification.'
          )
        const response = await controlJob({
          action: 'start',
          id,
          digest: options.approve,
          hostShell: true,
        })
        const job = response.job ?? readJob(id)
        if (options.json) json(job)
        else
          output(
            `Task ${id} accepted: ${job.status}. It continues when this viewer closes.\nInspect: coral jobs show ${id}\nFollow: coral jobs logs ${id} --follow`
          )
      }
    )

  command
    .command('list')
    .description('List tasks without starting or changing execution')
    .option('--json', 'print task records as JSON')
    .action((options: { json?: boolean }) =>
    {
      const { jobs, invalid } = listJobRecords()
      if (options.json) json(jobs)
      else if (jobs.length === 0 && invalid.length === 0)
        output('No coding tasks yet. Create one with coral jobs plan.')
      else
        for (const job of jobs)
          output(
            `${job.id}  ${job.status.padEnd(16)}  ${job.spec.objective.replace(/\s+/g, ' ')}`
          )
      for (const record of invalid)
        process.stderr.write(
          `${record.id}  unreadable        ${sanitizeUntrustedText(record.error)}\n`
        )
    })

  command
    .command('show <id>')
    .description(
      'Inspect the specification, progress, checks, and review location'
    )
    .option('--transcript', 'include the last settled conversation checkpoint')
    .option('--json', 'print task details, digest, and draft path as JSON')
    .action((id: string, options: { transcript?: boolean; json?: boolean }) =>
    {
      const job = readJob(id)
      if (options.json)
        json({
          job,
          digest: jobSpecDigest(job.spec),
          draftPath: join(jobDirectory(id), 'job.json'),
          ...(options.transcript && job.snapshot
            ? { transcript: readJobSnapshot(id, job.snapshot) }
            : {}),
        })
      else describe(job, options.transcript)
    })

  command
    .command('logs <id>')
    .description('Read bounded task events; follow until settlement or Ctrl+C')
    .option(
      '-f, --follow',
      'follow new events; closing the viewer leaves the task running'
    )
    .option(
      '--after <sequence>',
      'only show events after this cursor',
      integer,
      0
    )
    .option('--json', 'emit one JSON event per line')
    .action(
      async (
        id: string,
        options: { follow?: boolean; after: number; json?: boolean }
      ) => followLogs(id, options, abort.signal)
    )

  command
    .command('cancel <id>')
    .description(
      'Cancel queued work or request joined termination of an active task'
    )
    .option('--json', 'print the task and whether cancellation is pending')
    .action(async (id: string, options: { json?: boolean }) =>
    {
      const response = await controlJob({ action: 'cancel', id })
      const job = response.job ?? readJob(id)
      const pending = job.status === 'running'
      if (options.json) json({ job, cancellationPending: pending })
      else
        output(
          pending
            ? `Cancellation requested for ${id}; owned processes are stopping. Use jobs show to inspect settlement.`
            : `Task ${id}: ${job.status}.`
        )
    })

  command
    .command('resume <id> [instructions]')
    .description(
      'Explicitly reconcile and continue a settled or interrupted task with retained budgets'
    )
    .option('--instructions <text>', 'additional continuation instructions')
    .option(
      '--prompt-file <path>',
      'read continuation instructions from a UTF-8 file'
    )
    .addOption(
      new Option(
        '--setup-resolution <resolution>',
        'explicitly retry or skip the displayed unsettled setup command'
      ).choices(['retry', 'skip'])
    )
    .addOption(
      new Option(
        '--shell-resolution <resolution>',
        'continue without replaying uncertain Agent shell commands, or permit retry of interrupted shell/check commands after inspection'
      ).choices(['continue', 'retry'])
    )
    .option('--json', 'print the queued task as JSON')
    .action(
      async (
        id: string,
        instructions: string | undefined,
        options: {
          promptFile?: string
          instructions?: string
          setupResolution?: 'retry' | 'skip'
          shellResolution?: 'continue' | 'retry'
          json?: boolean
        }
      ) =>
      {
        if (instructions !== undefined && options.instructions !== undefined)
          throw new Error(
            'Provide positional instructions or --instructions, not both.'
          )
        const supplied = options.instructions ?? instructions
        const text =
          supplied !== undefined || options.promptFile !== undefined
            ? await objectiveFromInput(supplied, options.promptFile)
            : 'Inspect current changes and reconcile uncertain effects before continuing the approved task.'
        const response = await controlJob({
          action: 'resume',
          id,
          instructions: text,
          setupResolution: options.setupResolution,
          shellResolution: options.shellResolution,
        })
        const job = response.job ?? readJob(id)
        if (options.json) json(job)
        else
          output(
            `Task ${id}: ${job.status}. Consumed time and repair attempts are retained.\nFollow: coral jobs logs ${id} --follow`
          )
      }
    )

  command
    .command('diff <id>')
    .description(
      'Show tracked, staged, and untracked changes in the owned worktree'
    )
    .option('--json', 'print the task ID, worktree, and diff as JSON')
    .action(async (id: string, options: { json?: boolean }) =>
    {
      const job = readJob(id)
      if (!job.worktree) throw new Error('This task has no worktree yet.')
      const diff = await getJobDiff(job, abort.signal)
      if (options.json) json({ id, worktree: job.worktree, diff })
      else output(diff || 'No worktree changes.')
    })

  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try
  {
    await command.parseAsync(args.length ? args : ['--help'], { from: 'user' })
    return interruptedBy === 'SIGTERM' ? 143 : interruptedBy ? 130 : 0
  }
  catch (error)
  {
    if (interruptedBy) return interruptedBy === 'SIGTERM' ? 143 : 130
    if (error instanceof CommanderError) return error.exitCode
    process.stderr.write(`${sanitizeUntrustedText(toErrorMessage(error))}\n`)
    return 1
  }
  finally
  {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}
