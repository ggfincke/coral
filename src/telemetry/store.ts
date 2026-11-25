// src/telemetry/store.ts
// per-model reliability telemetry persistence

import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import {
  makeReliabilityStats,
  type ReliabilityStats,
} from '../types/inference.js'
import { coralHomePath } from '../utils/coral-home.js'
import { isPlainObject } from '../utils/guards.js'
import { readJsonObjectFile, writeJsonFile } from '../utils/json.js'
import { pluralize } from '../utils/pluralize.js'

// reliability accumulated across agent lifetimes for one model
interface ModelTelemetry
{
  reliability: ReliabilityStats
  sessions: number
  firstSeen: string
  updatedAt: string
}

interface TelemetryEvent
{
  version: number
  id: string
  model: string
  reliability: ReliabilityStats
  recordedAt: string
}

export interface TelemetryStore
{
  models: Record<string, ModelTelemetry>
}

// labels used by /telemetry output
const RELIABILITY_LABELS: Record<keyof ReliabilityStats, string> = {
  repairedToolCalls: 'tool-call repairs',
  nameRepairs: 'name repairs',
  stallNudges: 'stall nudges',
  validationFailures: 'invalid args',
  editRepairs: 'edit fixes',
  doomLoopTrips: 'doom-loop trips',
  reprompts: 'reprompts',
  verifyFlags: 'verify flags',
  verifyReprompts: 'verify fixes',
}

const TELEMETRY_EVENT_VERSION = 1
const TELEMETRY_EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RELIABILITY_KEYS = Object.keys(
  makeReliabilityStats()
) as (keyof ReliabilityStats)[]

function telemetryPath(): string
{
  return coralHomePath('telemetry.json')
}

// keep eval-harness counters separate from interactive telemetry
export function evalTelemetryPath(): string
{
  return coralHomePath('eval-telemetry.json')
}

function emptyStore(): TelemetryStore
{
  return {
    models: Object.create(null) as Record<string, ModelTelemetry>,
  }
}

function telemetryEventsDir(path: string): string
{
  const extension = extname(path)
  const stem =
    extension === '.json' ? basename(path, extension) : basename(path)
  return join(dirname(path), `${stem}.d`)
}

// missing counters default to zero; a present non-counter rejects the record
function readReliability(value: unknown): ReliabilityStats | undefined
{
  if (!isPlainObject(value)) return undefined

  const stats = makeReliabilityStats()
  for (const key of RELIABILITY_KEYS)
  {
    if (!Object.hasOwn(value, key)) continue
    const raw = value[key]
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0)
    {
      return undefined
    }
    stats[key] = raw
  }
  return stats
}

function isIsoTimestamp(value: unknown): value is string
{
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  )
}

function isTelemetryEvent(value: unknown): value is TelemetryEvent
{
  return (
    isPlainObject(value) &&
    value.version === TELEMETRY_EVENT_VERSION &&
    typeof value.id === 'string' &&
    TELEMETRY_EVENT_ID_PATTERN.test(value.id) &&
    typeof value.model === 'string' &&
    value.model.length > 0 &&
    isIsoTimestamp(value.recordedAt) &&
    readReliability(value.reliability) !== undefined
  )
}

function loadTelemetryEvents(path: string): TelemetryEvent[]
{
  const dir = telemetryEventsDir(path)
  let files: string[]
  try
  {
    files = readdirSync(dir).sort()
  }
  catch
  {
    return []
  }

  const seen = new Set<string>()
  const events: TelemetryEvent[] = []
  for (const file of files)
  {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -'.json'.length)
    if (!TELEMETRY_EVENT_ID_PATTERN.test(id)) continue

    const value = readJsonObjectFile(join(dir, file))
    if (!isTelemetryEvent(value) || value.id !== id || seen.has(value.id))
    {
      continue
    }
    const reliability = readReliability(value.reliability)
    if (!reliability) continue
    seen.add(value.id)
    events.push({ ...value, reliability })
  }
  return events
}

function mergeTelemetryEvent(
  store: TelemetryStore,
  event: TelemetryEvent
): void
{
  const existing = Object.hasOwn(store.models, event.model)
    ? store.models[event.model]
    : undefined
  store.models[event.model] = {
    reliability: addReliability(existing?.reliability, event.reliability),
    sessions: (existing?.sessions ?? 0) + 1,
    firstSeen:
      existing && existing.firstSeen.localeCompare(event.recordedAt) <= 0
        ? existing.firstSeen
        : event.recordedAt,
    updatedAt:
      existing && existing.updatedAt.localeCompare(event.recordedAt) >= 0
        ? existing.updatedAt
        : event.recordedAt,
  }
}

// add counters from the live stats so stale or corrupt records cannot drop keys
export function addReliability(
  base: ReliabilityStats | undefined,
  add: ReliabilityStats
): ReliabilityStats
{
  const sum = {} as ReliabilityStats
  for (const key of Object.keys(add) as (keyof ReliabilityStats)[])
  {
    const prev = Number(base?.[key]) || 0
    sum[key] = prev + add[key]
  }
  return sum
}

// fold the immutable events beside path, returning an empty store when none
export function loadTelemetry(path = telemetryPath()): TelemetryStore
{
  const store = emptyStore()
  for (const event of loadTelemetryEvents(path))
  {
    mergeTelemetryEvent(store, event)
  }
  return store
}

// persist one immutable event so concurrent writers never merge in place
export function recordReliability(
  model: string,
  stats: ReliabilityStats,
  now: string = new Date().toISOString(),
  path: string = telemetryPath()
): void
{
  if (!model || !isIsoTimestamp(now))
  {
    throw new Error('Telemetry events require a model and ISO timestamp')
  }
  const id = randomUUID()
  const reliability = readReliability(stats)
  if (!reliability)
  {
    throw new Error('Reliability stats must be non-negative integer counters')
  }
  const event: TelemetryEvent = {
    version: TELEMETRY_EVENT_VERSION,
    id,
    model,
    reliability,
    recordedAt: now,
  }
  writeJsonFile(join(telemetryEventsDir(path), `${id}.json`), event)
}

// render one newest-first block per model for /telemetry
export function formatTelemetry(store: TelemetryStore): string[]
{
  const models = Object.entries(store.models)
  if (models.length === 0)
  {
    return ['No telemetry recorded yet.']
  }

  models.sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))

  const lines: string[] = []
  for (const [model, record] of models)
  {
    lines.push(`${model}  (${pluralize(record.sessions, 'session')})`)

    const counters = (
      Object.keys(RELIABILITY_LABELS) as (keyof ReliabilityStats)[]
    )
      .filter((key) => (Number(record.reliability[key]) || 0) > 0)
      .map((key) => `  ${RELIABILITY_LABELS[key]}: ${record.reliability[key]}`)

    if (counters.length === 0)
    {
      lines.push('  no repairs needed')
    }
    else
    {
      lines.push(...counters)
    }
  }
  return lines
}
