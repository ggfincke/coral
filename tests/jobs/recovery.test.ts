// tests/jobs/recovery.test.ts
// preserve side effects and require explicit recovery across uncertain checkpoints

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { executeJob } from '../../src/jobs/worker.js'
import { jobSpecDigest, readJob, writeJob } from '../../src/jobs/store.js'
import type { JobRecord } from '../../src/jobs/types.js'
import { makeFakeAgent } from '../helpers/agent-harness.js'
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

test('interrupted verification needs an explicit retry before the agreed suite runs again', async () =>
{
  const job = await fixture()
  let calls = 0
  const createAgent: NonNullable<
    Parameters<typeof executeJob>[1]
  >['createAgent'] = (record, options) =>
    makeFakeAgent(
      record.worktree!.path,
      [
        [
          {
            message: {
              role: 'assistant',
              content: 'Current files inspected; task implementation complete.',
            },
            done: true,
          },
        ],
      ],
      options
    ).agent
  await executeJob(job.id, {
    createAgent,
    async runJobCommand(_command, options)
    {
      calls++
      await writeFile(join(options.cwd, 'check-effect.txt'), 'preserved')
      throw new Error('Check process lost after its filesystem side effect')
    },
  })
  const interrupted = readJob(job.id)
  assert.equal(interrupted.pendingCommand?.phase, 'checks')
  const consumed = interrupted.consumedMs
  interrupted.status = 'running'
  interrupted.continuation = 'Inspect current files and continue.'
  writeJob(interrupted)
  const runJobCommand = async () =>
  {
    calls++
    return { ok: true, output: 'verified' }
  }
  const paused = await executeJob(job.id, { createAgent, runJobCommand })
  assert.equal(paused.status, 'needs_input')
  assert.match(paused.error!, /shell resolution retry/)
  assert.equal(calls, 1)
  assert.equal(
    await readFile(join(paused.worktree!.path, 'check-effect.txt'), 'utf8'),
    'preserved'
  )
  assert.ok(paused.consumedMs >= consumed)
  assert.equal(paused.repairs, 2)
  paused.status = 'running'
  paused.continuation = 'The effects are understood; retry verification.'
  paused.resumeShell = 'retry'
  writeJob(paused)
  const completed = await executeJob(job.id, { createAgent, runJobCommand })
  assert.equal(completed.status, 'ready_for_review')
  assert.equal(calls, 2)
  assert.equal(completed.pendingCommand, undefined)
})

async function fixture(setup: string[] = []): Promise<JobRecord>
{
  const root = await pool.tempDir('coral-job-recovery-')
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
    consumedMs: 1000,
    repairs: 2,
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
      setup,
      checks: ['verify'],
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

test('checkpoint failure preserves file effects and prevents the next phase', async () =>
{
  const job = await fixture()
  let checks = 0
  await assert.rejects(
    executeJob(job.id, {
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
                        name: 'write_file',
                        arguments: { path: 'source.txt', content: 'after\n' },
                      },
                    },
                    {
                      function: {
                        name: 'bash',
                        arguments: { command: 'printf recorded' },
                      },
                    },
                  ],
                },
                done: true,
              },
            ],
            [
              {
                message: { role: 'assistant', content: 'Implemented' },
                done: true,
              },
            ],
          ],
          options
        ).agent
      },
      writeJobSnapshot()
      {
        throw new Error('checkpoint unavailable')
      },
      async runJobCommand(command)
      {
        if (command === 'verify') checks++
        return { ok: true, output: 'pass' }
      },
    }),
    /checkpoint unavailable/
  )
  const saved = readJob(job.id)
  assert.equal(
    await readFile(join(saved.worktree!.path, 'source.txt'), 'utf8'),
    'after\n'
  )
  assert.equal(saved.phase, 'implement')
  assert.equal(saved.status, 'running')
  assert.equal(saved.snapshot, undefined)
  assert.equal(saved.unsettledShells?.[0].command, 'printf recorded')
  assert.deepEqual(saved.unsettledShells?.[0].result, {
    ok: true,
    output: 'pass',
  })
  assert.equal(checks, 0)
})

for (const interruptedBy of ['process failure', 'cancellation'])
{
  test(`setup ${interruptedBy} requires explicit resolution and preserves budgets`, async () =>
  {
    const job = await fixture(['setup-once'])
    let setupCalls = 0
    const cancel = new AbortController()
    await executeJob(
      job.id,
      {
        async runJobCommand(_command, options)
        {
          setupCalls++
          await writeFile(join(options.cwd, 'effect.txt'), 'already happened')
          if (interruptedBy === 'process failure')
            throw new Error('worker interrupted after filesystem side effect')
          cancel.abort()
          return { ok: false, output: 'Command cancelled' }
        },
      },
      cancel.signal
    )
    const interrupted = readJob(job.id)
    assert.equal(interrupted.pendingCommand?.command, 'setup-once')
    const beforeResume = interrupted.consumedMs
    interrupted.status = 'running'
    interrupted.continuation = 'Inspect existing state and continue safely.'
    interrupted.activeSince = new Date().toISOString()
    writeJob(interrupted)
    let writableDuringReconcile = false
    const resumed = await executeJob(job.id, {
      createAgent(record, options)
      {
        writableDuringReconcile ||= options.tools!.some(
          (tool) => tool.name === 'bash' || tool.name === 'write_file'
        )
        return makeFakeAgent(
          record.worktree!.path,
          [
            [
              {
                message: {
                  role: 'assistant',
                  content:
                    'Setup effect already exists; the command outcome remains uncertain.',
                },
                done: true,
              },
            ],
          ],
          options
        ).agent
      },
      async runJobCommand()
      {
        setupCalls++
        return { ok: true, output: 'pass' }
      },
    })
    assert.equal(resumed.status, 'needs_input')
    assert.match(resumed.error!, /explicit setup resolution/)
    assert.equal(setupCalls, 1)
    assert.equal(writableDuringReconcile, false)
    assert.equal(
      await readFile(join(resumed.worktree!.path, 'effect.txt'), 'utf8'),
      'already happened'
    )
    assert.ok(resumed.consumedMs >= beforeResume)
    assert.equal(resumed.repairs, 2)
    assert.ok(resumed.snapshot)

    resumed.status = 'running'
    resumed.continuation = 'Keep the existing setup effects, then finish.'
    resumed.resumeSetup = 'skip'
    resumed.activeSince = new Date().toISOString()
    writeJob(resumed)
    const commands: string[] = []
    const completed = await executeJob(job.id, {
      createAgent(record, options)
      {
        return makeFakeAgent(
          record.worktree!.path,
          [
            [
              {
                message: {
                  role: 'assistant',
                  content: 'Verified existing state and finished',
                },
                done: true,
              },
            ],
          ],
          options
        ).agent
      },
      async runJobCommand(command)
      {
        commands.push(command)
        return { ok: true, output: 'pass' }
      },
    })
    assert.equal(completed.status, 'ready_for_review')
    assert.deepEqual(commands, ['verify'])
    assert.equal(completed.repairs, 2)
    assert.equal(completed.setupCompleted, 1)
  })
}

test('active-time heartbeats persist during inference without partial snapshots', async () =>
{
  const job = await fixture()
  let observed: JobRecord | undefined
  const completed = await executeJob(job.id, {
    createAgent(record, options)
    {
      return makeFakeAgent(
        record.worktree!.path,
        async function* ()
        {
          await new Promise((resolve) => setTimeout(resolve, 1200))
          observed = readJob(record.id)
          yield { message: { role: 'assistant', content: 'Done' }, done: true }
        },
        options
      ).agent
    },
    async runJobCommand()
    {
      return { ok: true, output: 'pass' }
    },
  })
  assert.ok(observed)
  assert.equal(observed.phase, 'implement')
  assert.equal(observed.snapshot, undefined)
  assert.ok(observed.consumedMs >= job.consumedMs + 900)
  assert.equal(completed.status, 'ready_for_review')
  assert.ok(completed.snapshot)
})

test('interrupted Agent shell evidence gates writable continuation until an explicit decision', async () =>
{
  const job = await fixture()
  const command = 'printf unique-once-effect >> effect.txt'
  const interrupted = await executeJob(job.id, {
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
                  { function: { name: 'bash', arguments: { command } } },
                ],
              },
              done: true,
            },
          ],
        ],
        options
      ).agent
    },
    async runJobCommand(_command, options)
    {
      await writeFile(join(options.cwd, 'effect.txt'), 'unique-once-effect')
      throw new Error('worker interrupted before command result checkpoint')
    },
  })
  assert.equal(interrupted.status, 'failed')
  assert.equal(interrupted.snapshot, undefined)
  assert.equal(interrupted.unsettledShells?.[0].command, command)
  assert.equal(interrupted.unsettledShells?.[0].result, undefined)
  interrupted.status = 'running'
  interrupted.continuation = 'Inspect and continue the task safely.'
  interrupted.activeSince = new Date().toISOString()
  writeJob(interrupted)
  let sawExactEvidence = false
  let writableTurns = 0
  let commandsRun = 0
  const paused = await executeJob(job.id, {
    createAgent(record, options)
    {
      if (options.tools!.some((tool) => tool.name === 'bash')) writableTurns++
      return makeFakeAgent(
        record.worktree!.path,
        async function* (request)
        {
          sawExactEvidence ||= JSON.stringify(request?.messages).includes(
            command
          )
          yield {
            message: {
              role: 'assistant',
              content:
                'The command may already have appended its marker; owner decision needed.',
            },
            done: true,
          }
        },
        options
      ).agent
    },
    async runJobCommand()
    {
      commandsRun++
      return { ok: true, output: 'unexpected' }
    },
  })
  assert.equal(paused.status, 'needs_input')
  assert.match(paused.error!, /explicit shell resolution/)
  assert.ok(sawExactEvidence)
  assert.equal(writableTurns, 0)
  assert.equal(commandsRun, 0)
  assert.equal(paused.unsettledShells?.[0].command, command)
  assert.ok(paused.snapshot)

  paused.status = 'running'
  paused.continuation =
    'Keep the existing marker and finish without repeating it.'
  paused.resumeShell = 'continue'
  paused.activeSince = new Date().toISOString()
  writeJob(paused)
  const commands: string[] = []
  const completed = await executeJob(job.id, {
    createAgent(record, options)
    {
      const writable = options.tools!.some((tool) => tool.name === 'bash')
      return makeFakeAgent(
        record.worktree!.path,
        writable
          ? [
              [
                {
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      { function: { name: 'bash', arguments: { command } } },
                    ],
                  },
                  done: true,
                },
              ],
              [
                {
                  message: {
                    role: 'assistant',
                    content: 'Retained the existing effect and finished.',
                  },
                  done: true,
                },
              ],
            ]
          : [
              [
                {
                  message: {
                    role: 'assistant',
                    content:
                      'The existing marker confirms the effect. Continue without replay.',
                  },
                  done: true,
                },
              ],
            ],
        options
      ).agent
    },
    async runJobCommand(command)
    {
      commands.push(command)
      return { ok: true, output: 'pass' }
    },
  })
  assert.equal(completed.status, 'ready_for_review')
  assert.deepEqual(commands, ['verify'])
  assert.equal(completed.unsettledShells, undefined)
  assert.equal(
    await readFile(join(completed.worktree!.path, 'effect.txt'), 'utf8'),
    'unique-once-effect'
  )
})
