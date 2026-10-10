// src/jobs/entry.ts
// host the supervisor and worker with explicit parent and signal lifetimes

import { executeJob } from './worker.js'
import { runJobSupervisor } from './supervisor.js'
import { appendJobEvent, writeJob } from './store.js'
import type { JobRecord } from './types.js'

// only the supervisor publishes terminal state after joining the worker and commands
function writeWorkerJob(job: JobRecord): void
{
  if (['draft', 'queued', 'running'].includes(job.status)) writeJob(job)
  else
    writeJob({
      ...job,
      status: 'running',
      settledStatus: job.status as NonNullable<JobRecord['settledStatus']>,
    })
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
      const job = await executeJob(
        id,
        { writeJob: writeWorkerJob },
        abort.signal
      )
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
    process.removeListener('SIGTERM', cancel)
    process.removeListener('SIGINT', cancel)
    process.removeListener('disconnect', loseOwner)
    if (process.connected) process.disconnect()
  }
}
