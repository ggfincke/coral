// tests/fixtures/persistence-worker.ts
// IPC-gated persistence operations for deterministic multiwriter tests

import { appendHistoryEntry } from '../../src/tui/prompt/input-history.js'
import { ProjectIndexer } from '../../src/retrieval/indexer.js'
import {
  embeddingSpaceDbPath,
  SqliteIndexStore,
} from '../../src/retrieval/sqlite-store.js'
import { saveSession } from '../../src/session/store.js'
import { recordReliability } from '../../src/telemetry/store.js'
import {
  trustMcpLaunch,
  type McpLaunchDescriptor,
} from '../../src/mcp/trust.js'
import { makeReliabilityStats } from '../../src/types/inference.js'
import type { Embedder, EmbeddingSpace } from '../../src/retrieval/types.js'
import { writeJsonFile } from '../../src/utils/json.js'
import { keywordVector } from '../helpers/embed.js'

interface WorkerInput
{
  id: string
  payload: WorkerPayload
}

type WorkerPayload =
  | JsonPayload
  | SessionPayload
  | TelemetryPayload
  | TrustPayload
  | HistoryPayload
  | RetrievalPayload

interface JsonPayload
{
  kind: 'json'
  path: string
  iterations: number
  payloadChars: number
}

interface SessionPayload
{
  kind: 'session'
  coralHome: string
  sessionIds: string[]
}

interface TelemetryPayload
{
  kind: 'telemetry'
  path: string
  iterations: number
}

interface TrustPayload
{
  kind: 'trust'
  coralHome: string
  descriptors: McpLaunchDescriptor[]
}

interface HistoryPayload
{
  kind: 'history'
  coralHome: string
  iterations: number
}

interface RetrievalPayload
{
  kind: 'retrieval'
  coralHome: string
  workspace: string
  space: EmbeddingSpace
  busyTimeoutMs: number
}

interface ParentMessage
{
  type: string
  data?: unknown
}

interface ParentWaiter
{
  resolve: (value: unknown) => void
}

const parentQueue = new Map<string, unknown[]>()
const parentWaiters = new Map<string, ParentWaiter[]>()

process.on('message', (message: unknown) =>
{
  if (
    typeof message !== 'object' ||
    message === null ||
    typeof (message as ParentMessage).type !== 'string'
  )
  {
    return
  }

  const envelope = message as ParentMessage
  const waiters = parentWaiters.get(envelope.type)
  const waiter = waiters?.shift()
  if (waiter)
  {
    waiter.resolve(envelope.data)
    if (waiters?.length === 0) parentWaiters.delete(envelope.type)
    return
  }

  const queue = parentQueue.get(envelope.type) ?? []
  queue.push(envelope.data)
  parentQueue.set(envelope.type, queue)
})

function send(type: string, data?: unknown): Promise<void>
{
  return new Promise((resolve, reject) =>
  {
    if (!process.send)
    {
      reject(new Error('Persistence worker requires an IPC channel'))
      return
    }
    process.send({ type, data }, (error) =>
    {
      if (error) reject(error)
      else resolve()
    })
  })
}

function waitForParent(type: string): Promise<unknown>
{
  const queue = parentQueue.get(type)
  if (queue && queue.length > 0)
  {
    const value = queue.shift()
    if (queue.length === 0) parentQueue.delete(type)
    return Promise.resolve(value)
  }

  return new Promise((resolve) =>
  {
    const waiters = parentWaiters.get(type) ?? []
    waiters.push({ resolve })
    parentWaiters.set(type, waiters)
  })
}

class PausedIpcEmbedder implements Embedder
{
  constructor(public space: EmbeddingSpace)
  {}

  async embed(texts: string[]): Promise<number[][]>
  {
    await send('embed-ready', { texts: texts.length })
    await waitForParent('release-embed')
    await send('write-ready')
    return texts.map((text) => keywordVector(text))
  }
}

function runJson(id: string, payload: JsonPayload): unknown
{
  const body = id
    .repeat(Math.ceil(payload.payloadChars / id.length))
    .slice(0, payload.payloadChars)
  for (let iteration = 0; iteration < payload.iterations; iteration++)
  {
    writeJsonFile(payload.path, { worker: id, iteration, body })
  }
  return { worker: id, iterations: payload.iterations }
}

function runSessions(id: string, payload: SessionPayload): unknown
{
  process.env.CORAL_HOME = payload.coralHome
  for (const sessionId of payload.sessionIds)
  {
    saveSession(sessionId, `model-${id}`, `/workspace/${id}`, [
      { role: 'system', content: 'System' },
      { role: 'user', content: `prompt-${id}` },
      { role: 'assistant', content: `response-${id}` },
    ])
  }
  return { worker: id, sessionIds: payload.sessionIds }
}

function runTelemetry(id: string, payload: TelemetryPayload): unknown
{
  for (let iteration = 0; iteration < payload.iterations; iteration++)
  {
    const recordedAt = new Date(
      Date.UTC(2026, 6, 18, 0, Number(id), iteration)
    ).toISOString()
    recordReliability(
      'shared-model',
      makeReliabilityStats({ reprompts: 1, editRepairs: iteration % 2 }),
      recordedAt,
      payload.path
    )
  }
  return { worker: id, iterations: payload.iterations }
}

function runTrust(payload: TrustPayload): unknown
{
  process.env.CORAL_HOME = payload.coralHome
  for (const descriptor of payload.descriptors) trustMcpLaunch(descriptor)
  return { aliases: payload.descriptors.map((descriptor) => descriptor.alias) }
}

function runHistory(id: string, payload: HistoryPayload): unknown
{
  process.env.CORAL_HOME = payload.coralHome
  for (let iteration = 0; iteration < payload.iterations; iteration++)
  {
    appendHistoryEntry({
      text: `history-${id}-${iteration}`,
      timestamp: Number(id) * 10_000 + iteration,
      sessionId: null,
    })
  }
  return { worker: id, iterations: payload.iterations }
}

async function runRetrieval(payload: RetrievalPayload): Promise<unknown>
{
  process.env.CORAL_HOME = payload.coralHome
  const store = new SqliteIndexStore(
    payload.space,
    embeddingSpaceDbPath(payload.space),
    { busyTimeoutMs: payload.busyTimeoutMs }
  )
  const indexer = new ProjectIndexer(
    payload.workspace,
    new PausedIpcEmbedder(payload.space),
    store
  )

  try
  {
    return await indexer.ensureIndexed()
  }
  finally
  {
    store.close()
  }
}

function run(input: WorkerInput): unknown | Promise<unknown>
{
  const { id, payload } = input
  switch (payload.kind)
  {
    case 'json':
      return runJson(id, payload)
    case 'session':
      return runSessions(id, payload)
    case 'telemetry':
      return runTelemetry(id, payload)
    case 'trust':
      return runTrust(payload)
    case 'history':
      return runHistory(id, payload)
    case 'retrieval':
      return runRetrieval(payload)
  }
}

async function main(): Promise<void>
{
  const raw = process.argv[2]
  if (!raw) throw new Error('Persistence worker input is required')
  const input = JSON.parse(raw) as WorkerInput
  const go = waitForParent('go')

  await send('ready')
  await go
  await send('done', await run(input))
}

try
{
  await main()
  process.disconnect?.()
}
catch (error)
{
  const message = error instanceof Error ? error.stack : String(error)
  await send('worker-error', message).catch(() => undefined)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
  process.disconnect?.()
}
