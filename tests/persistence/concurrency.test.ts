// tests/persistence/concurrency.test.ts
// deterministic cross-process contracts for Coral local persistence

import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'
import {
  fingerprintMcpLaunch,
  isMcpLaunchTrusted,
  type McpLaunchDescriptor,
} from '../../src/mcp/trust.js'
import { createEmbeddingSpace } from '../../src/retrieval/embedding-space.js'
import { ProjectIndexer } from '../../src/retrieval/indexer.js'
import {
  embeddingSpaceDbPath,
  RETRIEVAL_APPLICATION_ID,
  RETRIEVAL_SCHEMA_VERSION,
  SqliteIndexStore,
} from '../../src/retrieval/sqlite-store.js'
import type { Embedder, EmbeddingSpace } from '../../src/retrieval/types.js'
import {
  listSessions,
  loadSession,
  type SessionMeta,
} from '../../src/session/store.js'
import {
  loadTelemetry,
  type TelemetryStore,
} from '../../src/telemetry/store.js'
import { loadHistory } from '../../src/tui/prompt/input-history.js'
import { makeReliabilityStats } from '../../src/types/inference.js'
import { writeJsonFile } from '../../src/utils/json.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import {
  finishRaceWorkers,
  runBarrierRace,
  startRaceWorkers,
  stopRaceWorkers,
} from '../helpers/child-race.js'
import { keywordVector } from '../helpers/embed.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()
const fixture = fileURLToPath(
  new URL('../fixtures/persistence-worker.ts', import.meta.url)
)

after(async () =>
{
  restoreCoralHome()
  await cleanup()
})

function sorted(values: Iterable<string>): string[]
{
  return [...values].sort()
}

function descriptor(alias: string, marker: string): McpLaunchDescriptor
{
  return {
    alias,
    command: process.execPath,
    executable: process.execPath,
    args: [marker],
    launchCwd: '/tmp',
    passEnv: [],
    enabledTools: ['echo'],
  }
}

class ImmediateEmbedder implements Embedder
{
  constructor(public space: EmbeddingSpace)
  {}

  async embed(texts: string[]): Promise<number[][]>
  {
    return texts.map((text) => keywordVector(text))
  }
}

test('unique atomic JSON replacement survives concurrent writers', async () =>
{
  const dir = await tempDir('coral-json-race-')
  const path = join(dir, 'shared.json')
  const staleFixedTemp = `${path}.tmp`
  const workerCount = 4
  const iterations = 40
  const payloadChars = 64 * 1024
  await mkdir(staleFixedTemp)

  await runBarrierRace(
    fixture,
    Array.from({ length: workerCount }, (_, index) => ({
      id: String(index),
      payload: { kind: 'json', path, iterations, payloadChars },
    }))
  )

  const final = JSON.parse(await readFile(path, 'utf-8')) as {
    worker: string
    iteration: number
    body: string
  }
  assert.ok(Number(final.worker) >= 0 && Number(final.worker) < workerCount)
  assert.ok(final.iteration >= 0 && final.iteration < iterations)
  assert.equal(final.body.length, payloadChars)
  assert.equal(final.body, final.worker.repeat(payloadChars))
  assert.deepEqual(sorted(await readdir(dir)), [
    'shared.json',
    'shared.json.tmp',
  ])
  assert.equal((await stat(staleFixedTemp)).isDirectory(), true)

  if (process.platform !== 'win32')
  {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
  }
})

test('session files remain authoritative across distinct and same-ID writers', async () =>
{
  const home = await tempDir('coral-session-race-')
  const sessionsDir = join(home, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(
    join(sessionsDir, 'index.json'),
    JSON.stringify({ version: 1, sessions: [] }),
    'utf-8'
  )

  const distinctIds = [
    ['00000001', '00000002'],
    ['00000003', '00000004'],
    ['00000005', '00000006'],
  ]
  await runBarrierRace(
    fixture,
    distinctIds.map((sessionIds, index) => ({
      id: String(index),
      payload: { kind: 'session', coralHome: home, sessionIds },
    }))
  )

  process.env.CORAL_HOME = home
  assert.deepEqual(
    sorted(listSessions().map((session) => session.id)),
    sorted(distinctIds.flat())
  )

  const sharedId = 'deadbeef'
  await runBarrierRace(
    fixture,
    ['8', '9'].map((id) => ({
      id,
      payload: { kind: 'session', coralHome: home, sessionIds: [sharedId] },
    }))
  )

  const loaded = loadSession(sharedId)
  assert.ok(loaded)
  const winner = loaded.meta.model.replace('model-', '')
  assert.ok(winner === '8' || winner === '9')
  assert.equal(loaded.meta.cwd, `/workspace/${winner}`)
  assert.equal(loaded.messages[1]?.content, `prompt-${winner}`)
  assert.equal(loaded.messages[2]?.content, `response-${winner}`)
  assert.equal(
    listSessions().filter((session: SessionMeta) => session.id === sharedId)
      .length,
    1
  )

  if (process.platform !== 'win32')
  {
    assert.equal((await stat(sessionsDir)).mode & 0o777, 0o700)
    for (const id of [...distinctIds.flat(), sharedId])
    {
      assert.equal(
        (await stat(join(sessionsDir, `${id}.json`))).mode & 0o777,
        0o600
      )
    }
  }
})

test('telemetry aggregates one legacy baseline and concurrent immutable deltas', async () =>
{
  const dir = await tempDir('coral-telemetry-race-')
  const path = join(dir, 'telemetry.json')
  const baseline: TelemetryStore = {
    models: {
      'shared-model': {
        reliability: makeReliabilityStats({ reprompts: 3, editRepairs: 1 }),
        sessions: 2,
        firstSeen: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T01:00:00.000Z',
      },
    },
  }
  writeJsonFile(path, baseline)

  const workerCount = 4
  const iterations = 8
  await runBarrierRace(
    fixture,
    Array.from({ length: workerCount }, (_, index) => ({
      id: String(index),
      payload: { kind: 'telemetry', path, iterations },
    }))
  )

  const expectedSessions = 2 + workerCount * iterations
  const expectedReprompts = 3 + workerCount * iterations
  const expectedEditRepairs =
    1 +
    workerCount *
      Array.from({ length: iterations }, (_, index) => index % 2).reduce(
        (sum, value) => sum + value,
        0
      )
  const first = loadTelemetry(path)
  const record = first.models['shared-model']
  assert.equal(record?.sessions, expectedSessions)
  assert.equal(record?.reliability.reprompts, expectedReprompts)
  assert.equal(record?.reliability.editRepairs, expectedEditRepairs)
  assert.equal(record?.firstSeen, '2026-07-17T00:00:00.000Z')

  const deltaDir = join(dir, 'telemetry.d')
  const deltaFiles = (await readdir(deltaDir)).filter((file) =>
    file.endsWith('.json')
  )
  assert.equal(deltaFiles.length, workerCount * iterations)
  const duplicate = JSON.parse(
    await readFile(join(deltaDir, deltaFiles[0]!), 'utf-8')
  ) as { id: string }
  await writeFile(
    join(deltaDir, `${randomUUID()}.json`),
    JSON.stringify(duplicate),
    { encoding: 'utf-8', mode: 0o600 }
  )
  await writeFile(join(deltaDir, 'interrupted.tmp'), '{"version":1', {
    encoding: 'utf-8',
    mode: 0o600,
  })

  assert.deepEqual(loadTelemetry(path), first)
  assert.deepEqual(loadTelemetry(path), first)

  if (process.platform !== 'win32')
  {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(deltaDir)).mode & 0o777, 0o700)
    for (const file of await readdir(deltaDir))
    {
      assert.equal((await stat(join(deltaDir, file))).mode & 0o777, 0o600)
    }
  }
})

test('MCP trust merges aliases and fails closed on conflicting or invalid sidecars', async () =>
{
  const home = await tempDir('coral-trust-race-')
  const legacy = descriptor('legacy', 'legacy')
  const shadowed = descriptor('legacy_shadow', 'legacy-shadow')
  writeJsonFile(join(home, 'mcp-trust.json'), {
    version: 1,
    servers: {
      legacy: {
        fingerprint: fingerprintMcpLaunch(legacy),
        approvedAt: '2026-07-17T00:00:00.000Z',
      },
      legacy_shadow: {
        fingerprint: fingerprintMcpLaunch(shadowed),
        approvedAt: '2026-07-17T00:00:00.000Z',
      },
    },
  })

  const distinct = ['alpha', 'beta', 'gamma'].map((alias) =>
    descriptor(alias, alias)
  )
  await runBarrierRace(
    fixture,
    distinct.map((item, index) => ({
      id: String(index),
      payload: { kind: 'trust', coralHome: home, descriptors: [item] },
    }))
  )

  process.env.CORAL_HOME = home
  assert.equal(isMcpLaunchTrusted(legacy), true)
  for (const item of distinct) assert.equal(isMcpLaunchTrusted(item), true)

  const sharedA = descriptor('shared', 'a')
  const sharedB = descriptor('shared', 'b')
  await runBarrierRace(
    fixture,
    [sharedA, sharedB].map((item, index) => ({
      id: String(index),
      payload: { kind: 'trust', coralHome: home, descriptors: [item] },
    }))
  )
  assert.equal(
    [sharedA, sharedB].filter((item) => isMcpLaunchTrusted(item)).length,
    1
  )

  const sidecarDir = join(home, 'mcp-trust.d')
  await writeFile(join(sidecarDir, 'legacy_shadow.json'), '{"broken":true}', {
    encoding: 'utf-8',
    mode: 0o600,
  })
  assert.equal(isMcpLaunchTrusted(shadowed), false)

  if (process.platform !== 'win32')
  {
    assert.equal((await stat(sidecarDir)).mode & 0o777, 0o700)
    for (const file of await readdir(sidecarDir))
    {
      assert.equal((await stat(join(sidecarDir, file))).mode & 0o777, 0o600)
    }
  }
})

test('history appends remain complete while loading is byte-stable and bounded', async () =>
{
  const home = await tempDir('coral-history-race-')
  const workerCount = 4
  const iterations = 160
  await runBarrierRace(
    fixture,
    Array.from({ length: workerCount }, (_, index) => ({
      id: String(index),
      payload: { kind: 'history', coralHome: home, iterations },
    }))
  )

  const path = join(home, 'history.jsonl')
  const before = await readFile(path)
  const rawEntries = before
    .toString('utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { text: string })
  assert.equal(rawEntries.length, workerCount * iterations)
  assert.equal(
    new Set(rawEntries.map((entry) => entry.text)).size,
    workerCount * iterations
  )

  process.env.CORAL_HOME = home
  const loaded = loadHistory()
  const after = await readFile(path)
  assert.deepEqual(after, before)
  assert.deepEqual(loaded, rawEntries.slice(-500))

  if (process.platform !== 'win32')
  {
    assert.equal((await stat(home)).mode & 0o777, 0o700)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  }
})

test('same-space SQLite initialization and refresh serialize across processes', async () =>
{
  const home = await tempDir('coral-retrieval-race-home-')
  const workspace = await tempDir('coral-retrieval-race-workspace-')
  await writeFile(
    join(workspace, 'feature.ts'),
    'export const login = "auth session"\n',
    'utf-8'
  )

  const legacyPath = join(home, 'retrieval', 'index.sqlite')
  await mkdir(join(home, 'retrieval'), { recursive: true })
  await writeFile(legacyPath, 'legacy cache sentinel\n', 'utf-8')
  const space = createEmbeddingSpace('http://127.0.0.1:11434', {
    model: 'test-embed:latest',
    digest: 'b'.repeat(64),
  })
  process.env.CORAL_HOME = home
  const dbPath = embeddingSpaceDbPath(space)
  const workers = await startRaceWorkers(
    fixture,
    ['a', 'b'].map((id) => ({
      id,
      payload: {
        kind: 'retrieval',
        coralHome: home,
        workspace,
        space,
        busyTimeoutMs: 5_000,
      },
    }))
  )

  let lockDb: Database.Database | undefined
  try
  {
    workers.forEach((worker) => worker.send('go'))
    await Promise.all(workers.map((worker) => worker.waitFor('embed-ready')))

    lockDb = new Database(dbPath, { timeout: 5_000 })
    lockDb.pragma('busy_timeout = 5000')
    lockDb.exec('BEGIN IMMEDIATE')
    workers.forEach((worker) => worker.send('release-embed'))
    await Promise.all(workers.map((worker) => worker.waitFor('write-ready')))
    await new Promise((resolve) => setTimeout(resolve, 100))
    lockDb.exec('COMMIT')
    lockDb.close()
    lockDb = undefined

    const results = (await finishRaceWorkers(workers)) as Array<{
      totalFiles: number
      embeddedFiles: number
      chunks: number
    }>
    assert.deepEqual(
      results.map((result) => result.totalFiles),
      [1, 1]
    )
    assert.deepEqual(
      results.map((result) => result.embeddedFiles),
      [1, 1]
    )
  }
  finally
  {
    if (lockDb)
    {
      try
      {
        lockDb.exec('ROLLBACK')
      }
      catch
      {
        // transaction may already be closed after a failed setup
      }
      lockDb.close()
    }
    await stopRaceWorkers(workers)
  }

  const store = new SqliteIndexStore(space, dbPath, {
    busyTimeoutMs: 5_000,
  })
  try
  {
    const indexer = new ProjectIndexer(
      workspace,
      new ImmediateEmbedder(space),
      store
    )
    const hits = await indexer.search('auth session', 1)
    assert.equal(hits[0]?.path, 'feature.ts')
    assert.match(hits[0]?.text ?? '', /auth session/)

    const inspect = new Database(dbPath, { readonly: true })
    try
    {
      assert.equal(
        inspect.pragma('application_id', { simple: true }),
        RETRIEVAL_APPLICATION_ID
      )
      assert.equal(
        inspect.pragma('user_version', { simple: true }),
        RETRIEVAL_SCHEMA_VERSION
      )
      assert.equal(inspect.pragma('journal_mode', { simple: true }), 'wal')
    }
    finally
    {
      inspect.close()
    }

    assert.equal(await readFile(legacyPath, 'utf-8'), 'legacy cache sentinel\n')
    assert.match(dbPath, /\/retrieval\/v2\/spaces\/[a-f\d]{64}\.sqlite$/)

    if (process.platform !== 'win32')
    {
      assert.equal((await stat(dbPath)).mode & 0o777, 0o600)
      assert.equal((await stat(dirname(dbPath))).mode & 0o777, 0o700)
      for (const suffix of ['-wal', '-shm'])
      {
        const sidecar = `${dbPath}${suffix}`
        if (existsSync(sidecar))
        {
          assert.equal((await stat(sidecar)).mode & 0o777, 0o600)
        }
      }
    }
  }
  finally
  {
    store.close()
  }
})
