// src/telemetry/store.ts
// persist per-model reliability telemetry across sessions (~/.coral/telemetry.json)

import { join } from 'node:path'
import type { ReliabilityStats } from '../agent/agent.js'
import { getCoralHome } from '../utils/coral-home.js'
import { isPlainObject } from '../utils/guards.js'
import { readJsonObjectFile, writeJsonFile } from '../utils/json.js'

const TELEMETRY_VERSION = 1

// lifetime reliability for one model, accumulated across agent lifetimes
export interface ModelTelemetry
{
  reliability: ReliabilityStats
  // count of agent lifetimes folded into this record
  sessions: number
  // ISO timestamp the model was first recorded
  firstSeen: string
  // ISO timestamp of the most recent fold
  updatedAt: string
}

export interface TelemetryStore
{
  version: number
  models: Record<string, ModelTelemetry>
}

// readable label per reliability counter — drives /telemetry output
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

export function telemetryPath(): string
{
  return join(getCoralHome(), 'telemetry.json')
}

function emptyStore(): TelemetryStore
{
  return { version: TELEMETRY_VERSION, models: {} }
}

// element-wise sum of two counter sets. keys come from the live `add` stats so
// a stale on-disk record can't silently drop a counter; existing values are
// coerced so a corrupt entry degrades to 0 rather than poisoning the total
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

// fold one agent lifetime's final stats into the per-model record (pure)
export function foldReliability(
  store: TelemetryStore,
  model: string,
  stats: ReliabilityStats,
  now: string
): TelemetryStore
{
  const existing = store.models[model]
  const record: ModelTelemetry = {
    reliability: addReliability(existing?.reliability, stats),
    sessions: (existing?.sessions ?? 0) + 1,
    firstSeen: existing?.firstSeen ?? now,
    updatedAt: now,
  }
  return {
    version: TELEMETRY_VERSION,
    models: { ...store.models, [model]: record },
  }
}

// load the store, returning an empty store when absent or malformed
export function loadTelemetry(path = telemetryPath()): TelemetryStore
{
  const raw = readJsonObjectFile(path)
  if (!raw || !isPlainObject(raw.models)) return emptyStore()
  return {
    version: TELEMETRY_VERSION,
    models: raw.models as Record<string, ModelTelemetry>,
  }
}

// fold a session's final stats into the on-disk store. `now` & `path` are
// injectable for tests; defaults hit the wall clock & ~/.coral
export function recordReliability(
  model: string,
  stats: ReliabilityStats,
  now: string = new Date().toISOString(),
  path: string = telemetryPath()
): TelemetryStore
{
  const next = foldReliability(loadTelemetry(path), model, stats, now)
  writeJsonFile(path, next)
  return next
}

// render the store for /telemetry — one block per model, newest activity first
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
    const sessions = record.sessions
    const label = sessions === 1 ? 'session' : 'sessions'
    lines.push(`${model}  (${sessions} ${label})`)

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
