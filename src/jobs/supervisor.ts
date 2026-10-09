// src/jobs/supervisor.ts
// serialize the durable task queue independently of interactive client lifetimes

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { writeJsonFile } from '../utils/json.js'
import { toErrorMessage } from '../utils/errors.js'
import {
  appendJobEvent,
  jobSpecDigest,
  listJobs,
  parseJobSpec,
  readJob,
  writeJob,
} from './store.js'
import {
  assertJobsPlatform,
  captureOwnedProcess,
  cleanupJobProcesses,
  processIdentity,
  terminateOwnedGroup,
  type OwnedJobProcess,
} from './process.js'
import {
  coralJobProcessArgs,
  jobProcessEnvironment,
  jobRuntimePaths,
} from './runtime.js'
import { assertJobWorktree } from './git.js'
import type { JobRecord, JobRequest, JobResponse } from './types.js'

export interface SupervisorOwner
{
  version: 1
  pid: number
  token: string
  identity: string
}

interface ActiveWorker
{
  jobId: string
  owner: OwnedJobProcess
}

export function readSupervisorOwner(): SupervisorOwner | undefined
{
  const path = jobRuntimePaths().owner
  let serialized: string
  try
  {
    serialized = readFileSync(path, 'utf8')
  }
  catch (error)
  {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const owner = JSON.parse(serialized) as SupervisorOwner
  if (
    owner.version !== 1 ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 1 ||
    typeof owner.token !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(owner.token) ||
    typeof owner.identity !== 'string' ||
    !owner.identity
  )
  {
    throw new Error(
      'Invalid supervisor ownership record; task execution is blocked.'
    )
  }
  return owner
}

function accountInterrupted(
  job: JobRecord,
  reason: string,
  observedExit = false
): void
{
  if (job.activeSince)
  {
    if (observedExit)
    {
      job.consumedMs += Math.max(0, Date.now() - Date.parse(job.activeSince))
    }
    delete job.activeSince
  }
  if (job.status === 'running')
  {
    delete job.settledStatus
    job.status = 'interrupted'
    job.error = reason
    writeJob(job)
    appendJobEvent(job.id, 'interrupted', reason)
  }
}

// a problem confined to one task parks it for the user instead of stopping
// the queue; nothing was left running for it
function requireInput(job: JobRecord, reason: string): void
{
  delete job.activeSince
  delete job.settledStatus
  job.status = 'needs_input'
  job.error = reason
  writeJob(job)
  appendJobEvent(job.id, 'needs_input', reason)
}

function isDirectory(path: string): boolean
{
  try
  {
    return statSync(path).isDirectory()
  }
  catch
  {
    return false
  }
}

async function recoverPreviousWorker(): Promise<void>
{
  const paths = jobRuntimePaths()
  if (existsSync(paths.active))
  {
    const active = JSON.parse(
      readFileSync(paths.active, 'utf8')
    ) as ActiveWorker
    if (
      !active ||
      typeof active.jobId !== 'string' ||
      !active.owner ||
      !Number.isSafeInteger(active.owner.pid) ||
      active.owner.pid <= 1 ||
      typeof active.owner.identity !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(active.owner.token)
    )
    {
      throw new Error(
        'Invalid active-worker identity; task execution is blocked.'
      )
    }
    // stop the old worker before inspecting command journals it could still update
    await terminateOwnedGroup(active.owner)
    await cleanupJobProcesses(active.jobId)
    accountInterrupted(
      readJob(active.jobId),
      'The previous supervisor stopped. Resume explicitly to reconcile this task.'
    )
    rmSync(paths.active)
  }
  for (const job of listJobs())
  {
    if (job.status !== 'running') continue
    await cleanupJobProcesses(job.id)
    accountInterrupted(
      job,
      'Execution stopped without a settled task result. Resume explicitly to reconcile it.'
    )
  }
}

function publishSupervisorCandidate(candidate: string, lock: string): boolean
{
  try
  {
    renameSync(candidate, lock)
    return true
  }
  catch (error)
  {
    if (
      ['EEXIST', 'ENOTEMPTY'].includes(
        (error as NodeJS.ErrnoException).code ?? ''
      )
    )
      return false
    throw error
  }
}

async function acquireSupervisor(): Promise<SupervisorOwner | undefined>
{
  const paths = jobRuntimePaths()
  const identity = await processIdentity(process.pid)
  if (!identity)
    throw new Error('Could not establish supervisor process identity.')
  const owner: SupervisorOwner = {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    identity,
  }
  const candidate = `${paths.lock}.candidate-${owner.token}`
  mkdirSync(candidate, { mode: 0o700 })
  try
  {
    // only complete owner records become visible at the shared lock path
    writeJsonFile(join(candidate, 'owner.json'), owner)
    if (publishSupervisorCandidate(candidate, paths.lock)) return owner
    const previous = readSupervisorOwner()
    if (!previous)
      return publishSupervisorCandidate(candidate, paths.lock)
        ? owner
        : undefined
    if ((await processIdentity(previous.pid)) === previous.identity)
      return undefined
    if (readSupervisorOwner()?.token !== previous.token) return undefined
    try
    {
      // retain this nonempty tombstone so a delayed reclaimer cannot retire a newer owner
      renameSync(paths.lock, `${paths.lock}.retired-${previous.token}`)
    }
    catch (error)
    {
      if (
        !['EEXIST', 'ENOTEMPTY', 'ENOENT'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        )
      )
        throw error
    }
    return publishSupervisorCandidate(candidate, paths.lock) ? owner : undefined
  }
  finally
  {
    // this unique unpublished directory contains only files from this acquisition attempt
    if (existsSync(candidate)) rmSync(candidate, { recursive: true })
  }
}

function validateRequest(value: unknown): JobRequest
{
  const request = value as JobRequest
  if (!request || typeof request !== 'object')
    throw new Error('Invalid task request.')
  if (request.action === 'ping') return request
  if (
    !['start', 'cancel', 'resume', 'edit'].includes(request.action) ||
    !('id' in request) ||
    typeof request.id !== 'string' ||
    !/^[0-9a-f]{8}$/.test(request.id)
  )
  {
    throw new Error('Invalid task request.')
  }
  if (request.action === 'edit')
  {
    if (typeof request.digest !== 'string')
      throw new Error('Draft editing requires its previous digest.')
    request.spec = parseJobSpec(request.spec)
  }
  if (
    request.action === 'start' &&
    (request.hostShell !== true || typeof request.digest !== 'string')
  )
  {
    throw new Error(
      'Starting requires confirmation of this exact draft and host shell execution.'
    )
  }
  if (
    request.action === 'resume' &&
    (typeof request.instructions !== 'string' ||
      request.instructions.length > 100_000 ||
      (request.shellResolution !== undefined &&
        !['continue', 'retry'].includes(request.shellResolution)) ||
      (request.setupResolution !== undefined &&
        !['retry', 'skip'].includes(request.setupResolution)))
  )
  {
    throw new Error('Invalid continuation instructions.')
  }
  return request
}

export async function runJobSupervisor(signal?: AbortSignal): Promise<void>
{
  assertJobsPlatform()
  const owner = await acquireSupervisor()
  if (!owner) return
  const paths = jobRuntimePaths()
  let active: ChildProcess | undefined
  let activeId: string | undefined
  let activeOwner: OwnedJobProcess | undefined
  let cancelRequested = false
  let stopping = false
  let blocked: string | undefined
  let queueRun: Promise<void> | undefined
  let serial = Promise.resolve()
  const sockets = new Set<Socket>()
  let idle: ReturnType<typeof setTimeout> | undefined
  let forceStop: ReturnType<typeof setTimeout> | undefined
  let budgetStop: ReturnType<typeof setTimeout> | undefined

  // * when worker ownership or control state cannot be proved, stop taking
  // work and exit; the next client starts a fresh supervisor whose recovery
  // re-checks the active-worker journal instead of leaving a wedged process
  const failClosed = (error: unknown) =>
  {
    blocked ??= toErrorMessage(error)
    if (stopping) return
    if (idle) clearTimeout(idle)
    // leave time for in-flight responses to reach their clients
    idle = setTimeout(shutdown, 1000)
  }

  const persistControl = (operation: () => void) =>
  {
    try
    {
      operation()
    }
    catch (error)
    {
      failClosed(error)
      throw error
    }
  }

  const stopWorker = () =>
  {
    active?.send({ type: stopping ? 'shutdown' : 'cancel' }, () =>
    {})
    if (!forceStop && activeOwner)
    {
      const target = activeOwner
      forceStop = setTimeout(() =>
      {
        void terminateOwnedGroup(target).catch(failClosed)
      }, 5000)
    }
  }

  const drain = async () =>
  {
    while (!stopping && !blocked)
    {
      const job = listJobs()
        .filter((entry) => entry.status === 'queued')
        .sort(
          (a, b) =>
            (a.queueOrder ?? 0) - (b.queueOrder ?? 0) ||
            (a.queuedAt ?? '').localeCompare(b.queuedAt ?? '') ||
            a.id.localeCompare(b.id)
        )[0]
      if (!job) return
      if (!job.approval || job.approval.digest !== jobSpecDigest(job.spec))
      {
        job.status = 'needs_input'
        job.error =
          'The approved draft changed; prepare and confirm a new task.'
        writeJob(job)
        continue
      }
      if (!isDirectory(job.spec.repository.source))
      {
        requireInput(
          job,
          `The source checkout is missing: ${job.spec.repository.source}. Restore it, then resume this task.`
        )
        continue
      }
      job.status = 'running'
      job.activeSince = new Date().toISOString()
      writeJob(job)
      const token = randomUUID()
      const child = spawn(
        process.execPath,
        coralJobProcessArgs('_worker', job.id),
        {
          cwd: job.spec.repository.source,
          detached: true,
          env: { ...jobProcessEnvironment(), CORAL_JOB_PROCESS_TOKEN: token },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        }
      )
      active = child
      activeId = job.id
      cancelRequested = false
      const exited = new Promise<number | null>((resolve, reject) =>
      {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      void exited.catch(() =>
      {})
      try
      {
        if (!child.pid)
        {
          // spawn failed outright, so no worker or command was started
          const reason = await exited.then(
            () => 'no process was created',
            (error: unknown) => toErrorMessage(error)
          )
          requireInput(
            readJob(job.id),
            `Could not start the task worker (${reason}). Resume this task to retry.`
          )
          continue
        }
        activeOwner = await captureOwnedProcess(child.pid, token)
        writeJsonFile(paths.active, { jobId: job.id, owner: activeOwner })
        child.send({ type: 'start' }, () =>
        {})
        budgetStop = setTimeout(
          () =>
          {
            child.send({ type: 'deadline' }, () =>
            {})
            if (activeOwner && !forceStop)
            {
              const target = activeOwner
              forceStop = setTimeout(() =>
              {
                void terminateOwnedGroup(target).catch(failClosed)
              }, 5000)
            }
          },
          Math.max(1, job.spec.activeTimeLimitMs - job.consumedMs) + 1000
        )
        if (stopping || cancelRequested) stopWorker()
        const exitCode = await exited
        await terminateOwnedGroup(activeOwner)
        await cleanupJobProcesses(job.id)
        const settled = readJob(job.id)
        if (
          exitCode === 0 &&
          settled.settledStatus &&
          !cancelRequested &&
          !stopping
        )
        {
          const worktreeProblem =
            settled.settledStatus === 'ready_for_review'
              ? await assertJobWorktree(settled).then(
                  () => undefined,
                  (error: unknown) => toErrorMessage(error)
                )
              : undefined
          if (worktreeProblem)
            requireInput(
              settled,
              `The task finished, but its worktree failed verification: ${worktreeProblem}`
            )
          else
          {
            settled.status = settled.settledStatus
            delete settled.settledStatus
            appendJobEvent(
              job.id,
              settled.status,
              'Worker and task commands have stopped.'
            )
            writeJob(settled)
          }
        }
        else if (cancelRequested && settled.status === 'running')
        {
          accountInterrupted(
            settled,
            'Task cancellation interrupted execution.',
            true
          )
          settled.status = 'cancelled'
          writeJob(settled)
        }
        else
          accountInterrupted(
            settled,
            'The worker exited before settling the task. Resume explicitly to inspect its changes.',
            true
          )
        rmSync(paths.active)
      }
      catch (error)
      {
        failClosed(error)
        appendJobEvent(
          job.id,
          'error',
          `Queue stopped: ${toErrorMessage(error)}. The next task command restarts the supervisor and recovers this task.`
        )
        // leave ownership journals intact when cleanup cannot be proved
        if (activeOwner) await terminateOwnedGroup(activeOwner).catch(() =>
        {})
        else child.kill('SIGTERM')
      }
      finally
      {
        if (forceStop) clearTimeout(forceStop)
        if (budgetStop) clearTimeout(budgetStop)
        budgetStop = undefined
        forceStop = undefined
        active = undefined
        activeId = undefined
        activeOwner = undefined
      }
    }
  }

  const kick = () =>
  {
    if (idle) clearTimeout(idle)
    if (queueRun || stopping || blocked) return
    queueRun = drain()
      .catch(failClosed)
      .finally(() =>
      {
        queueRun = undefined
        if (!stopping && !blocked)
        {
          try
          {
            if (listJobs().some((job) => job.status === 'queued'))
            {
              kick()
              return
            }
          }
          catch (error)
          {
            failClosed(error)
            return
          }
          // an idle supervisor is demand-started again by the next mutating client
          idle = setTimeout(shutdown, 60_000)
        }
      })
  }

  const handle = async (request: JobRequest): Promise<JobResponse> =>
  {
    if (blocked)
      return {
        ok: false,
        error: `${blocked} The task supervisor is restarting; retry shortly.`,
      }
    if (stopping)
      return { ok: false, error: 'Task supervisor is stopping. Retry shortly.' }
    if (request.action === 'ping') return { ok: true }
    const job = readJob(request.id)
    if (request.action === 'edit')
    {
      if (
        job.status !== 'draft' ||
        jobSpecDigest(job.spec) !== request.digest
      )
      {
        throw new Error(
          'This draft changed or was started. Reload it before editing.'
        )
      }
      job.spec = request.spec
      job.updatedAt = new Date().toISOString()
      persistControl(() => writeJob(job))
    }
    else if (request.action === 'start')
    {
      if (job.status !== 'draft')
        throw new Error('Only a draft task can be started.')
      if (request.digest !== jobSpecDigest(job.spec))
        throw new Error('The draft changed. Review it before starting.')
      job.approval = {
        digest: request.digest,
        hostShell: true,
        approvedAt: new Date().toISOString(),
      }
      job.status = 'queued'
      job.queuedAt = new Date().toISOString()
      job.queueOrder =
        Math.max(0, ...listJobs().map((entry) => entry.queueOrder ?? 0)) + 1
      persistControl(() =>
      {
        appendJobEvent(job.id, 'queued', 'Approved task added to the queue.')
        writeJob(job)
      })
      kick()
    }
    else if (request.action === 'cancel')
    {
      if (job.status === 'running')
      {
        if (activeId !== job.id)
          throw new Error(
            'Task ownership is uncertain; cancellation was not sent.'
          )
        cancelRequested = true
        stopWorker()
      }
      else if (
        ['queued', 'draft', 'interrupted', 'needs_input'].includes(job.status)
      )
      {
        // unprovable leftovers block only this task's control, not the queue
        await cleanupJobProcesses(job.id)
        job.status = 'cancelled'
        persistControl(() => writeJob(job))
      }
    }
    else
    {
      if (
        ![
          'interrupted',
          'cancelled',
          'needs_input',
          'failed',
          'ready_for_review',
        ].includes(job.status)
      )
      {
        throw new Error('Only a settled or interrupted task can be continued.')
      }
      if (!job.approval || job.approval.digest !== jobSpecDigest(job.spec))
      {
        throw new Error(
          'Task approval no longer matches its specification. Prepare a new draft.'
        )
      }
      if (job.consumedMs >= job.spec.activeTimeLimitMs)
      {
        throw new Error(
          'This task exhausted its approved time. Prepare a new task with an appropriate limit.'
        )
      }
      await cleanupJobProcesses(job.id)
      job.continuation =
        request.instructions ||
        'Inspect current files and continue the approved task from observed state.'
      job.resumeSetup = request.setupResolution
      job.resumeShell = request.shellResolution
      job.status = 'queued'
      job.queuedAt = new Date().toISOString()
      job.queueOrder =
        Math.max(0, ...listJobs().map((entry) => entry.queueOrder ?? 0)) + 1
      delete job.error
      persistControl(() =>
      {
        appendJobEvent(
          job.id,
          'queued',
          'Explicit continuation queued; consumed time and repair attempts are retained.'
        )
        writeJob(job)
      })
      kick()
    }
    return { ok: true, job: readJob(job.id) }
  }

  const server = createServer((socket) =>
  {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () =>
    {})
    socket.setTimeout(10_000, () => socket.destroy())
    let buffer = ''
    let received = false
    socket.on('data', (chunk) =>
    {
      if (received) return
      buffer += chunk.toString('utf8')
      if (buffer.length > 8 * 1024 * 1024)
      {
        socket.destroy()
        return
      }
      if (!buffer.includes('\n')) return
      received = true
      serial = serial
        .then(async () =>
        {
          try
          {
            const message = JSON.parse(
              buffer.slice(0, buffer.indexOf('\n'))
            ) as { token?: unknown; request?: unknown }
            if (message.token !== owner.token)
              throw new Error('Task control authentication failed.')
            socket.end(
              `${JSON.stringify(await handle(validateRequest(message.request)))}\n`
            )
          }
          catch (error)
          {
            socket.end(
              `${JSON.stringify({ ok: false, error: toErrorMessage(error) })}\n`
            )
          }
        })
        .catch(() =>
        {
          socket.destroy()
        })
    })
  })
  let resolveStopped: () => void = () =>
  {}
  const stopped = new Promise<void>((resolve) =>
  {
    resolveStopped = resolve
  })
  function shutdown(): void
  {
    if (stopping) return
    stopping = true
    if (idle) clearTimeout(idle)
    stopWorker()
    for (const socket of sockets) socket.destroy()
    server.close(() => resolveStopped())
  }

  try
  {
    await recoverPreviousWorker()
    rmSync(paths.socket, { force: true })
    await new Promise<void>((resolve, reject) =>
    {
      server.once('error', reject)
      server.listen(paths.socket, () =>
      {
        chmodSync(paths.socket, 0o600)
        resolve()
      })
    })
    signal?.addEventListener('abort', shutdown, { once: true })
    if (signal?.aborted) shutdown()
    else kick()
    await stopped
    await serial
    await queueRun
  }
  finally
  {
    signal?.removeEventListener('abort', shutdown)
    if (idle) clearTimeout(idle)
    if (forceStop) clearTimeout(forceStop)
    if (readSupervisorOwner()?.token === owner.token)
    {
      rmSync(paths.socket, { force: true })
      const retired = `${paths.lock}.retired-${owner.token}`
      renameSync(paths.lock, retired)
      // a normally released live owner cannot have passed another contender's dead-owner check
      rmSync(join(retired, 'owner.json'))
      rmdirSync(retired)
    }
  }
}
