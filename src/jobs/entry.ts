// src/jobs/entry.ts
// host the supervisor and worker with explicit parent and signal lifetimes

import { executeJob } from './worker.js'
import { runJobSupervisor } from './supervisor.js'
import { appendJobEvent, flushJobEvents, writeJob } from './store.js'
import { toErrorMessage } from '../utils/errors.js'
import {
  SETTLED_JOB_STATUSES,
  type JobRecord,
  type SettledJobStatus,
} from './types.js'

function isSettledStatus(status: string): status is SettledJobStatus
{
  return (SETTLED_JOB_STATUSES as readonly string[]).includes(status)
}

// only the supervisor publishes terminal state after joining the worker and commands
function writeWorkerJob(job: JobRecord): void
{
  if (!isSettledStatus(job.status)) writeJob(job)
  else writeJob({ ...job, status: 'running', settledStatus: job.status })
}

// the worker's stdio is ignored, so a fatal error is kept in the task log
// where the user can read why the worker exited before settling
async function executeWorker(id: string, signal: AbortSignal)
{
  try
  {
    return await executeJob(id, { writeJob: writeWorkerJob }, signal)
  }
  catch (error)
  {
    try
    {
      appendJobEvent(id, 'worker_error', toErrorMessage(error))
    }
    catch
    {
      // the log may be what failed; the supervisor still reports the exit
    }
    throw error
  }
}

export async function runJobService(kind: string, id?: string): Promise<void>
{
  const abort = new AbortController()
  const cancel = () => abort.abort()
  let ownerLost = false
  let deadlineReached = false
  const loseOwner = () =>
  {
    ownerLost = true
    cancel()
  }
  process.on('SIGTERM', cancel)
  process.on('SIGINT', cancel)
  try
  {
    if (kind === '_supervise')
    {
      await runJobSupervisor(abort.signal)
      return
    }
    if (!id || !process.send)
      throw new Error('Task workers require an owning supervisor.')
    process.once('disconnect', loseOwner)
    const started = await new Promise<boolean>((resolve) =>
    {
      const onMessage = (message: unknown) =>
      {
        const type = (message as { type?: unknown } | null)?.type
        if (type === 'cancel') cancel()
        if (type === 'shutdown') loseOwner()
        if (type === 'deadline')
        {
          deadlineReached = true
          cancel()
        }
        if (type === 'start') resolve(true)
      }
      process.on('message', onMessage)
      abort.signal.addEventListener('abort', () => resolve(false), {
        once: true,
      })
    })
    if (started && !abort.signal.aborted)
    {
      const job = await executeWorker(id, abort.signal)
      if (ownerLost)
      {
        job.status = 'interrupted'
        job.error =
          'The owning supervisor disconnected. Resume explicitly to reconcile this task.'
        writeWorkerJob(job)
        appendJobEvent(id, 'interrupted', job.error)
      }
      else if (deadlineReached)
      {
        job.status = 'needs_input'
        job.error = 'The approved active execution budget was exhausted.'
        writeWorkerJob(job)
        appendJobEvent(id, 'needs_input', job.error)
      }
    }
  }
  finally
  {
    if (id && kind === '_worker')
    {
      try
      {
        flushJobEvents(id)
      }
      catch
      {
        // a stored flush error already failed the run's settled append;
        // otherwise the run itself failed and only its last events are lost
      }
    }
    process.removeListener('SIGTERM', cancel)
    process.removeListener('SIGINT', cancel)
    process.removeListener('disconnect', loseOwner)
    if (process.connected) process.disconnect()
  }
}
