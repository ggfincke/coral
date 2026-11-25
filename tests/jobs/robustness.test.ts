// tests/jobs/robustness.test.ts
// keep unstorable requests and commands from wedging the task queue or worker

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { sendJobRequest } from '../../src/jobs/client.js'
import { createJobPlan } from '../../src/jobs/plan.js'
import { jobRuntimePaths } from '../../src/jobs/runtime.js'
import {
  jobSpecDigest,
  readJob,
  readJobEvents,
  writeJob,
} from '../../src/jobs/store.js'
import {
  readSupervisorOwner,
  runJobSupervisor,
} from '../../src/jobs/supervisor.js'
import type { JobRecord } from '../../src/jobs/types.js'
import { executeJob } from '../../src/jobs/worker.js'
import type { ChatRequest } from '../../src/types/inference.js'
import { makeFakeAgent, type FakeChunk } from '../helpers/agent-harness.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { initTestRepo } from '../helpers/git.js'
import { makeTempDirPool } from '../helpers/temp.js'

const pool = makeTempDirPool({ autoCleanup: false })
const restoreHome = captureCoralHome()
const originalAgentsHome = process.env.AGENTS_HOME
after(async () =>
{
  restoreHome()
  if (originalAgentsHome === undefined) delete process.env.AGENTS_HOME
  else process.env.AGENTS_HOME = originalAgentsHome
  await pool.cleanup()
})

// an approved record whose worktree is a plain temp dir; worker tests stub git
async function approvedJob(
  status: JobRecord['status']
): Promise<{ dir: string; job: JobRecord }>
{
  const dir = await pool.tempDir('coral-job-robustness-')
  process.env.CORAL_HOME = join(dir, 'home')
  const now = new Date().toISOString()
  const spec: JobRecord['spec'] = {
    objective: 'Write a file',
    model: 'fake-model',
    host: 'http://localhost:11434',
    repository: {
      source: join(dir, 'missing'),
      commonDir: join(dir, 'missing', '.git'),
      commit: 'a'.repeat(40),
    },
    plan: 'Write it.',
    setup: [],
    checks: [],
    activeTimeLimitMs: 60_000,
    maxRepairs: 0,
  }
  const job: JobRecord = {
    version: 1,
    id: randomBytes(4).toString('hex'),
    createdAt: now,
    updatedAt: now,
    status,
    ...(status === 'running' ? { activeSince: now } : {}),
    consumedMs: 0,
    repairs: 0,
    commandResults: [],
    spec,
    approval: { digest: jobSpecDigest(spec), hostShell: true, approvedAt: now },
  }
  writeJob(job)
  return { dir, job }
}

function bashTurns(args: Record<string, unknown>): FakeChunk[][]
{
  return [
    [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'bash', arguments: args } }],
        },
        done: true,
      },
    ],
    [{ message: { role: 'assistant', content: 'done' }, done: true }],
  ]
}

function runWorker(
  dir: string,
  job: JobRecord,
  script:
    FakeChunk[][] | ((request?: ChatRequest) => AsyncGenerator<FakeChunk>),
  runJobCommand?: NonNullable<Parameters<typeof executeJob>[1]>['runJobCommand']
): Promise<JobRecord>
{
  return executeJob(job.id, {
    createAgent: (_record, options) =>
      makeFakeAgent(dir, script, {
        ...options,
        inferenceClient: {
          async showModel()
          {
            return { contextLength: 131_072, architecture: 'gemma' }
          },
        },
      }).agent,
    async ensureJobWorktree(record)
    {
      return {
        ...record,
        worktree: { path: dir, branch: `coral/job-${record.id}` },
      }
    },
    async assertJobWorktree()
    {},
    ...(runJobCommand ? { runJobCommand } : {}),
  })
}

test('resume instructions the record cannot store fail without stopping the supervisor', async () =>
{
  const { job } = await approvedJob('interrupted')
  const controller = new AbortController()
  const supervisor = runJobSupervisor(controller.signal)
  try
  {
    while (!readSupervisorOwner())
      await new Promise((resolve) => setTimeout(resolve, 25))
    let ping
    do ping = await sendJobRequest({ action: 'ping' }).catch(() => undefined)
    while (!ping?.ok)
    const response = await sendJobRequest({
      action: 'resume',
      id: job.id,
      instructions: 'fix the h\0e\0ader',
      environment: {},
    })
    assert.equal(response.ok, false)
    assert.match(response.error ?? '', /Invalid continuation instructions/)
    // a fail-closed supervisor would refuse this and exit within a second
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.deepEqual(await sendJobRequest({ action: 'ping' }), { ok: true })
    assert.equal(readJob(job.id).status, 'interrupted')
    assert.deepEqual(readJobEvents(job.id), [])
  }
  finally
  {
    controller.abort()
    await supervisor
    await rm(jobRuntimePaths().directory, { recursive: true, force: true })
  }
})

test('a bash command the record cannot hold is a tool error, not a worker failure', async () =>
{
  for (const command of [
    `cat > big.txt <<'EOF'\n${'x'.repeat(17_000)}\nEOF`,
    '   ',
  ])
  {
    const { dir, job } = await approvedJob('running')
    let commandsRun = 0
    const settled = await runWorker(
      dir,
      job,
      bashTurns({ command }),
      async () =>
      {
        commandsRun++
        return { ok: true, output: '' }
      }
    )
    assert.equal(settled.status, 'ready_for_review')
    assert.equal(commandsRun, 0)
    const stored = readJob(job.id)
    assert.equal(stored.status, 'ready_for_review')
    assert.equal(stored.unsettledShells, undefined)
    const result = readJobEvents(job.id).find(
      (event) => event.type === 'tool_result'
    )
    assert.match(result?.text ?? '', /16384|nonempty command/)
  }
})

test('a bash timeout of zero runs the command under the default deadline', async () =>
{
  const { dir, job } = await approvedJob('running')
  const settled = await runWorker(
    dir,
    job,
    bashTurns({ command: 'sleep 0.2; echo finished', timeout: 0 })
  )
  assert.equal(settled.status, 'ready_for_review')
  const result = readJobEvents(job.id).find(
    (event) => event.type === 'shell_result'
  )
  const parsed = JSON.parse(result!.text) as { ok: boolean; output: string }
  assert.equal(parsed.ok, true)
  assert.match(parsed.output, /finished/)
})

test('task Agents load the standing AGENTS_HOME instructions', async () =>
{
  const { dir, job } = await approvedJob('running')
  const agentsHome = join(dir, 'agents')
  await mkdir(agentsHome)
  await writeFile(join(agentsHome, 'AGENTS.md'), 'Always use pnpm here.\n')
  process.env.AGENTS_HOME = agentsHome
  let system = ''
  await runWorker(dir, job, async function* (request)
  {
    system ||= String(request?.messages[0]?.content ?? '')
    yield { message: { role: 'assistant', content: 'done' }, done: true }
  })
  assert.match(system, /Always use pnpm here\./)
})

test('planning rejects an objective with a NUL byte before any model call', async () =>
{
  const root = await pool.tempDir('coral-job-plan-')
  process.env.CORAL_HOME = join(root, 'home')
  const git = initTestRepo(root)
  await writeFile(join(root, 'source.txt'), 'before\n')
  git('add', 'source.txt')
  assert.equal(git('commit', '-m', 'initial').status, 0)
  let modelCalls = 0
  await assert.rejects(
    createJobPlan(
      {
        cwd: root,
        objective: 'fix the h\0e\0ader',
        model: 'fake-model',
        host: 'http://localhost:11434',
      },
      {
        client: {
          // eslint-disable-next-line require-yield
          async *chatStream()
          {
            modelCalls++
            throw new Error('planning reached the model')
          },
        } as never,
      }
    ),
    /field objective/
  )
  assert.equal(modelCalls, 0)
})
