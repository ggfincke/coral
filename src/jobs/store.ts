// src/jobs/store.ts
// private atomic task records, bounded events, and immutable session checkpoints

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { decodeSessionData, encodeSessionData } from '../session/codec.js'
import type { SessionData } from '../session/types.js'
import { coralHomePath } from '../utils/coral-home.js'
import { ensurePrivateDir } from '../utils/fs.js'
import { toErrorMessage } from '../utils/errors.js'
import { isPlainObject } from '../utils/guards.js'
import { writeJsonFile } from '../utils/json.js'
import { sanitizeUntrustedText } from '../utils/untrusted-text.js'
import type { JobEvent, JobRecord, JobSpec } from './types.js'

const JOB_ID = /^[0-9a-f]{8}$/
const SNAPSHOT_NAME = /^snapshot-[0-9a-f-]{36}\.json$/
const OUTPUT_NAME = /^output-[0-9a-f-]{36}\.log$/
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const DIGEST = /^[0-9a-f]{64}$/
const MAX_RECORD_BYTES = 16 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_FILE_BYTES = 4 * 1024 * 1024
// records keep only this much of each command's output so they stay small
// enough to rewrite on every heartbeat
export const JOB_OUTPUT_TAIL_CHARS = 8_192
const MAX_EVENTS_BYTES = 2 * 1024 * 1024
const MAX_EVENT_TEXT = 16 * 1024
const STATUSES = new Set([
  'draft',
  'queued',
  'running',
  'ready_for_review',
  'needs_input',
  'interrupted',
  'cancelled',
  'failed',
])
const PHASES = new Set(['setup', 'implement', 'checks', 'repair', 'reconcile'])

function text(value: unknown, limit = 100_000): value is string
{
  return (
    typeof value === 'string' && value.length <= limit && !value.includes('\0')
  )
}

function nonempty(value: unknown, limit = 100_000): value is string
{
  return text(value, limit) && value.trim().length > 0
}

function integer(value: unknown): value is number
{
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function timestamp(value: unknown): value is string
{
  return text(value, 40) && Number.isFinite(Date.parse(value))
}

function commands(value: unknown): value is string[]
{
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every((command) => nonempty(command, 16_384))
  )
}

function validSpec(value: unknown): value is JobSpec
{
  if (!isPlainObject(value) || !isPlainObject(value.repository)) return false
  const repository = value.repository
  return (
    nonempty(value.objective, 32_768) &&
    nonempty(value.model, 1024) &&
    nonempty(value.host, 4096) &&
    nonempty(value.plan) &&
    nonempty(repository.source, 4096) &&
    isAbsolute(repository.source) &&
    nonempty(repository.commonDir, 4096) &&
    isAbsolute(repository.commonDir) &&
    typeof repository.commit === 'string' &&
    SHA.test(repository.commit) &&
    commands(value.setup) &&
    commands(value.checks) &&
    integer(value.activeTimeLimitMs) &&
    value.activeTimeLimitMs > 0 &&
    value.activeTimeLimitMs <= 2_147_482_000 &&
    integer(value.maxRepairs)
  )
}

export function parseJobSpec(value: unknown): JobSpec
{
  if (!validSpec(value))
    throw new Error(
      'Invalid task specification. Keep repository identity, objective, model, plan, command arrays, and positive execution limits intact.'
    )
  return structuredClone(value)
}

function validRecord(value: unknown): value is JobRecord
{
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    !JOB_ID.test(value.id) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status) ||
    !validSpec(value.spec) ||
    !integer(value.consumedMs) ||
    !integer(value.repairs) ||
    !Array.isArray(value.commandResults) ||
    value.commandResults.length > 10_000
  )
  {
    return false
  }
  for (const result of value.commandResults)
  {
    if (
      !isPlainObject(result) ||
      !['setup', 'checks'].includes(String(result.phase)) ||
      !nonempty(result.command, 16_384) ||
      !integer(result.attempt) ||
      typeof result.ok !== 'boolean' ||
      !text(result.output, 1024 * 1024) ||
      (result.outputFile !== undefined &&
        (typeof result.outputFile !== 'string' ||
          !OUTPUT_NAME.test(result.outputFile))) ||
      !timestamp(result.startedAt) ||
      !timestamp(result.finishedAt)
    )
      return false
  }
  for (const key of ['queuedAt', 'activeSince'])
  {
    if (value[key] !== undefined && !timestamp(value[key])) return false
  }
  if (value.queueOrder !== undefined && !integer(value.queueOrder)) return false
  if (
    value.settledStatus !== undefined &&
    (value.status !== 'running' ||
      ![
        'ready_for_review',
        'needs_input',
        'interrupted',
        'cancelled',
        'failed',
      ].includes(String(value.settledStatus)))
  )
    return false
  if (
    value.resumeShell !== undefined &&
    !['continue', 'retry'].includes(String(value.resumeShell))
  )
    return false
  if (value.unsettledShells !== undefined)
  {
    if (
      !Array.isArray(value.unsettledShells) ||
      value.unsettledShells.length > 1000
    )
      return false
    for (const shell of value.unsettledShells)
    {
      if (
        !isPlainObject(shell) ||
        !nonempty(shell.command, 16_384) ||
        !timestamp(shell.startedAt)
      )
        return false
      if (
        shell.result !== undefined &&
        (!isPlainObject(shell.result) ||
          typeof shell.result.ok !== 'boolean' ||
          !text(shell.result.output, 16_384))
      )
        return false
    }
  }
  for (const key of ['continuation', 'summary', 'error'])
  {
    if (value[key] !== undefined && !text(value[key], 1024 * 1024)) return false
  }
  if (
    value.phase !== undefined &&
    (typeof value.phase !== 'string' || !PHASES.has(value.phase))
  )
    return false
  if (
    value.snapshot !== undefined &&
    (typeof value.snapshot !== 'string' || !SNAPSHOT_NAME.test(value.snapshot))
  )
    return false
  if (value.setupCompleted !== undefined && !integer(value.setupCompleted))
    return false
  if (
    value.resumeSetup !== undefined &&
    value.resumeSetup !== 'retry' &&
    value.resumeSetup !== 'skip'
  )
    return false
  if (value.pendingCommand !== undefined)
  {
    const pending = value.pendingCommand
    if (
      !isPlainObject(pending) ||
      !['setup', 'checks'].includes(String(pending.phase)) ||
      !nonempty(pending.command, 16_384) ||
      !integer(pending.index) ||
      !integer(pending.attempt)
    )
      return false
  }
  if (value.worktree !== undefined)
  {
    const worktree = value.worktree
    if (
      !isPlainObject(worktree) ||
      !nonempty(worktree.path, 4096) ||
      !isAbsolute(worktree.path) ||
      worktree.branch !== `codex/job-${value.id}`
    )
      return false
  }
  if (value.approval !== undefined)
  {
    const approval = value.approval
    if (
      !isPlainObject(approval) ||
      approval.hostShell !== true ||
      !timestamp(approval.approvedAt) ||
      typeof approval.digest !== 'string' ||
      !DIGEST.test(approval.digest) ||
      approval.digest !== jobSpecDigest(value.spec)
    )
      return false
  }
  return (
    value.status === 'draft' ||
    value.approval !== undefined ||
    (value.status === 'cancelled' &&
      value.worktree === undefined &&
      value.phase === undefined &&
      value.consumedMs === 0)
  )
}

function privateDirectory(path: string): void
{
  assertDirectory(path)
  ensurePrivateDir(path)
}

function assertDirectory(path: string): void
{
  if (
    existsSync(path) &&
    (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
  )
  {
    throw new Error(`Task state directory is not an owned directory: ${path}`)
  }
}

function assertStateDirectories(id?: string): void
{
  assertDirectory(coralHomePath())
  assertDirectory(jobsDirectory())
  if (id !== undefined) assertDirectory(jobDirectory(id))
}

function prepareDirectory(id: string): string
{
  privateDirectory(coralHomePath())
  privateDirectory(jobsDirectory())
  const directory = jobDirectory(id)
  privateDirectory(directory)
  return directory
}

function readValue(path: string, maxBytes: number): unknown
{
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
  {
    throw new Error(`Invalid or oversized task state file: ${path}`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

export function jobsDirectory(): string
{
  return coralHomePath('jobs')
}

export function jobDirectory(id: string): string
{
  if (!JOB_ID.test(id)) throw new Error(`Invalid task ID: ${id}`)
  return join(jobsDirectory(), id)
}

// field order is explicit so draft JSON formatting never changes approval identity
export function jobSpecDigest(spec: JobSpec): string
{
  return createHash('sha256')
    .update(
      JSON.stringify({
        objective: spec.objective,
        model: spec.model,
        host: spec.host,
        repository: {
          source: spec.repository.source,
          commonDir: spec.repository.commonDir,
          commit: spec.repository.commit,
        },
        plan: spec.plan,
        setup: spec.setup,
        checks: spec.checks,
        activeTimeLimitMs: spec.activeTimeLimitMs,
        maxRepairs: spec.maxRepairs,
      })
    )
    .digest('hex')
}

export function readJob(id: string): JobRecord
{
  assertStateDirectories(id)
  const path = join(jobDirectory(id), 'job.json')
  if (!existsSync(path)) throw new Error(`Task not found: ${id}`)
  const value = readValue(path, MAX_RECORD_BYTES)
  if (!validRecord(value) || value.id !== id)
  {
    throw new Error(
      `Invalid task record ${id}; preserve the file and correct the draft or restore its last valid record`
    )
  }
  return value
}

export function writeJob(job: JobRecord): void
{
  if (!validRecord(job))
    throw new Error('Refusing to persist an invalid task record')
  const path = join(prepareDirectory(job.id), 'job.json')
  if (existsSync(path))
  {
    const previous = readJob(job.id)
    if (
      previous.status !== 'draft' &&
      (jobSpecDigest(previous.spec) !== jobSpecDigest(job.spec) ||
        JSON.stringify(previous.approval) !== JSON.stringify(job.approval))
    )
    {
      throw new Error(
        `Approved task ${job.id} cannot change its specification or approval`
      )
    }
  }
  if (Buffer.byteLength(JSON.stringify(job)) > MAX_RECORD_BYTES)
  {
    throw new Error(`Task ${job.id} exceeded its record storage limit`)
  }
  writeJsonFile(path, job)
}

export interface JobListing
{
  jobs: JobRecord[]
  // unreadable records stay on disk for the user to fix; they never block
  // listing or the queue
  invalid: { id: string; error: string }[]
}

export function listJobRecords(): JobListing
{
  assertStateDirectories()
  const listing: JobListing = { jobs: [], invalid: [] }
  if (!existsSync(jobsDirectory())) return listing
  for (const entry of readdirSync(jobsDirectory(), { withFileTypes: true }))
  {
    if (
      !entry.isDirectory() ||
      !JOB_ID.test(entry.name) ||
      !existsSync(join(jobDirectory(entry.name), 'job.json'))
    )
      continue
    try
    {
      listing.jobs.push(readJob(entry.name))
    }
    catch (error)
    {
      listing.invalid.push({ id: entry.name, error: toErrorMessage(error) })
    }
  }
  listing.jobs.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  )
  listing.invalid.sort((a, b) => a.id.localeCompare(b.id))
  return listing
}

export function listJobs(): JobRecord[]
{
  return listJobRecords().jobs
}

export function readJobEvents(id: string, after = 0): JobEvent[]
{
  assertStateDirectories(id)
  if (!integer(after))
    throw new Error('Task log cursor must be a nonnegative integer')
  const path = join(jobDirectory(id), 'events.json')
  if (!existsSync(path)) return []
  const value = readValue(path, MAX_EVENTS_BYTES)
  if (!Array.isArray(value)) throw new Error(`Invalid task events: ${id}`)
  let previous = 0
  for (const event of value)
  {
    if (
      !isPlainObject(event) ||
      !integer(event.sequence) ||
      event.sequence <= previous ||
      !timestamp(event.at) ||
      !nonempty(event.type, 80) ||
      !text(event.text, MAX_EVENT_TEXT)
    )
    {
      throw new Error(`Invalid task event stream: ${id}`)
    }
    previous = event.sequence
  }
  const events = (value as JobEvent[]).filter((event) => event.sequence > after)
  if (events.length > 0 && events[0].sequence > after + 1)
  {
    events.unshift({
      sequence: events[0].sequence - 1,
      at: events[0].at,
      type: 'truncated',
      text: '[Earlier task events were pruned from the bounded log.]',
    })
  }
  return events
}

// one supervisor or its active worker owns writes; viewers only read whole files
export function appendJobEvent(id: string, type: string, value: string): void
{
  if (!nonempty(type, 80)) throw new Error('Invalid task event type')
  const events = readJobEvents(id).filter((event) => event.type !== 'truncated')
  const sanitized = sanitizeUntrustedText(value)
  const event: JobEvent = {
    sequence: (events.at(-1)?.sequence ?? 0) + 1,
    at: new Date().toISOString(),
    type,
    text:
      sanitized.length > MAX_EVENT_TEXT
        ? sanitized.slice(0, MAX_EVENT_TEXT - 20) + '\n[output truncated]'
        : sanitized,
  }
  events.push(event)
  let bytes = Buffer.byteLength(JSON.stringify(events, null, 2))
  while (
    events.length > 1 &&
    (bytes > MAX_EVENTS_BYTES || events.length > 2048)
  )
  {
    events.shift()
    bytes = Buffer.byteLength(JSON.stringify(events, null, 2))
  }
  writeJsonFile(join(prepareDirectory(id), 'events.json'), events)
}

export function writeJobSnapshot(id: string, session: SessionData): string
{
  const encoded = encodeSessionData(session)
  const valid = decodeSessionData(encoded)
  if (!valid || valid.meta.id !== id)
    throw new Error(`Invalid task checkpoint: ${id}`)
  const data = JSON.stringify(encoded, null, 2)
  if (Buffer.byteLength(data) > MAX_SNAPSHOT_BYTES)
    throw new Error(`Task ${id} checkpoint is too large`)
  const name = `snapshot-${randomUUID()}.json`
  writeFileSync(join(prepareDirectory(id), name), data, {
    flag: 'wx',
    mode: 0o600,
  })
  return name
}

// full command output is immutable evidence beside the record
export function writeJobCommandOutput(id: string, output: string): string
{
  const name = `output-${randomUUID()}.log`
  writeFileSync(join(prepareDirectory(id), name), output, {
    flag: 'wx',
    mode: 0o600,
  })
  return name
}

export function jobCommandOutputPath(id: string, name: string): string
{
  if (!OUTPUT_NAME.test(name)) throw new Error('Invalid task output name')
  return join(jobDirectory(id), name)
}

export function readJobCommandOutput(id: string, name: string): string
{
  assertStateDirectories(id)
  const path = jobCommandOutputPath(id, name)
  const info = lstatSync(path)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_OUTPUT_FILE_BYTES
  )
  {
    throw new Error(`Invalid or oversized task output file: ${path}`)
  }
  return readFileSync(path, 'utf8')
}

export function readJobSnapshot(id: string, name: string): SessionData
{
  assertStateDirectories(id)
  if (!SNAPSHOT_NAME.test(name)) throw new Error('Invalid task checkpoint name')
  const session = decodeSessionData(
    readValue(join(jobDirectory(id), name), MAX_SNAPSHOT_BYTES)
  )
  if (!session || session.meta.id !== id)
    throw new Error(`Invalid task checkpoint: ${id}`)
  return session
}
