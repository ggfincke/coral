// tests/jobs/completion.test.ts
// require natural completion and complete verification evidence before task review

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { executeJob } from '../../src/jobs/worker.js'
import { jobSpecDigest, writeJob } from '../../src/jobs/store.js'
import type { JobRecord } from '../../src/jobs/types.js'
import { makeFakeAgent, makeAgentEvents } from '../helpers/agent-harness.js'
import { initTestRepo } from '../helpers/git.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { captureCoralHome } from '../helpers/coral-home.js'

const pool = makeTempDirPool({ autoCleanup: false })
const restoreHome = captureCoralHome()
after(async () =>
{
  restoreHome()
  await pool.cleanup()
})

async function fixture(): Promise<JobRecord>
{
  const root = await pool.tempDir('coral-job-completion-')
  process.env.CORAL_HOME = join(root, 'home')
  const git = initTestRepo(root)
  await writeFile(join(root, 'source.txt'), 'before\n')
  git('add', 'source.txt')
  assert.equal(git('commit', '-m', 'initial').status, 0)
  const now = new Date().toISOString()
  const job: JobRecord = {
    version: 1,
    id: randomBytes(4).toString('hex'),
    createdAt: now,
    updatedAt: now,
    status: 'running',
    activeSince: now,
    consumedMs: 0,
    repairs: 0,
    commandResults: [],
    spec: {
      objective: 'Update the source',
      model: 'fake-model',
      host: 'http://localhost:11434',
      repository: {
        source: root,
        commonDir: git(
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir'
        ).stdout.trim(),
        commit: git('rev-parse', 'HEAD').stdout.trim(),
      },
      plan: 'Update source and run the checks.',
      setup: [],
      checks: ['check-a', 'check-b'],
      activeTimeLimitMs: 60_000,
      maxRepairs: 3,
    },
  }
  job.approval = {
    digest: jobSpecDigest(job.spec),
    approvedAt: now,
    hostShell: true,
  }
  writeJob(job)
  return job
}

test('repair reruns the complete suite and retains all command evidence', async () =>
{
  const job = await fixture()
  const commands: string[] = []
  let turns = 0
  const result = await executeJob(job.id, {
    createAgent(record, options)
    {
      return makeFakeAgent(
        record.worktree!.path,
        async function* ()
        {
          turns++
          yield {
            message: {
              role: 'assistant',
              content: turns === 1 ? 'Implemented' : 'Repaired',
            },
            done: true,
          }
        },
        options
      ).agent
    },
    async runJobCommand(command)
    {
      commands.push(command)
      return {
        ok: commands.length !== 1,
        output: commands.length === 1 ? 'failure' : 'pass',
      }
    },
  })
  assert.equal(result.status, 'ready_for_review')
  assert.equal(result.repairs, 1)
  assert.equal(turns, 2)
  assert.deepEqual(commands, ['check-a', 'check-b', 'check-a', 'check-b'])
  assert.deepEqual(
    result.commandResults.map((check) => check.ok),
    [false, true, true, true]
  )
  assert.ok(result.snapshot)
  assert.ok(result.consumedMs > 0)
  assert.equal(result.activeSince, undefined)
})

test('failed checks stop at the approved repair limit', async () =>
{
  const job = await fixture()
  let turns = 0
  const result = await executeJob(job.id, {
    createAgent(record, options)
    {
      return makeFakeAgent(
        record.worktree!.path,
        async function* ()
        {
          turns++
          yield {
            message: { role: 'assistant', content: 'Attempted' },
            done: true,
          }
        },
        options
      ).agent
    },
    async runJobCommand()
    {
      return { ok: false, output: 'still failing' }
    },
  })
  assert.equal(result.status, 'needs_input')
  assert.equal(result.repairs, 3)
  assert.equal(turns, 4)
  assert.equal(result.commandResults.length, 8)
  assert.match(result.error!, /repair budget/)
})

test('Agent iteration exhaustion never becomes ready for review', async () =>
{
  const job = await fixture()
  let checks = 0
  const result = await executeJob(job.id, {
    createAgent(record, options)
    {
      return makeFakeAgent(
        record.worktree!.path,
        [
          [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    function: {
                      name: 'read_file',
                      arguments: { path: 'source.txt' },
                    },
                  },
                ],
              },
              done: true,
            },
          ],
        ],
        { ...options, maxIterations: 1 }
      ).agent
    },
    async runJobCommand()
    {
      checks++
      return { ok: true, output: 'pass' }
    },
  })
  assert.equal(result.status, 'needs_input')
  assert.match(result.error!, /iteration_limit/)
  assert.equal(checks, 0)
})

test('unexpected Git-state changes invalidate completion before checks', async () =>
{
  const job = await fixture()
  let checks = 0
  const result = await executeJob(job.id, {
    createAgent(record, options)
    {
      return makeFakeAgent(
        record.worktree!.path,
        async function* ()
        {
          const git = initTestRepo(record.worktree!.path)
          assert.equal(
            git('commit', '--allow-empty', '-m', 'unexpected').status,
            0
          )
          yield { message: { role: 'assistant', content: 'Done' }, done: true }
        },
        options
      ).agent
    },
    async runJobCommand()
    {
      checks++
      return { ok: true, output: 'pass' }
    },
  })
  assert.equal(result.status, 'failed')
  assert.match(result.error!, /HEAD|commit|identity/i)
  assert.equal(checks, 0)
})

test('settled Agent outcomes preserve legacy callbacks for cancellation, failure, and disposal', async () =>
{
  const root = await pool.tempDir('coral-job-outcomes-')
  process.env.CORAL_HOME = join(root, 'home')
  const { agent } = makeFakeAgent(
    root,
    [[{ message: { role: 'assistant', content: 'Done' }, done: true }]],
    { mcpMode: 'off' }
  )
  let done = 0
  const events = makeAgentEvents({
    onDone()
    {
      done++
    },
  })
  assert.equal((await agent.run('hello', events)).status, 'completed')
  assert.equal(
    (await agent.run('cancel', events, AbortSignal.abort())).status,
    'cancelled'
  )
  await agent.dispose()
  assert.equal((await agent.run('disposed', events)).status, 'stopped')
  assert.equal(done, 3)
  const broken = makeFakeAgent(
    root,
    async function* ()
    {
      yield {
        message: { role: 'assistant' as const, content: 'Partial' },
        done: false,
      }
      throw new Error('inference failed')
    },
    { mcpMode: 'off' }
  ).agent
  let errors = 0
  const outcome = await broken.run(
    'fail',
    makeAgentEvents({
      onError()
      {
        errors++
      },
    })
  )
  assert.equal(outcome.status, 'failed')
  assert.equal(errors, 1)
  await broken.dispose()
})
