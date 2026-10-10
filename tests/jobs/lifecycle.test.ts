// tests/jobs/lifecycle.test.ts
// preserve FIFO execution across detached clients and settle cancellation before dispatch

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { controlJob, sendJobRequest } from '../../src/jobs/client.js'
import {
  ownedGroupMembers,
  processIdentity,
  type OwnedJobProcess,
} from '../../src/jobs/process.js'
import { jobRuntimePaths } from '../../src/jobs/runtime.js'
import { readSupervisorOwner } from '../../src/jobs/supervisor.js'
import {
  jobDirectory,
  jobSpecDigest,
  readJob,
  readJobEvents,
  writeJob,
} from '../../src/jobs/store.js'
import { resolveJobRepository } from '../../src/jobs/git.js'
import type { JobRecord, JobRequest } from '../../src/jobs/types.js'
import { execFileCommand } from '../../src/utils/process.js'
import { captureCoralHome } from '../helpers/coral-home.js'
import { initTestRepo } from '../helpers/git.js'
import { makeTempDirPool } from '../helpers/temp.js'

const pool = makeTempDirPool({ autoCleanup: false })
const restoreHome = captureCoralHome()
after(async () =>
{
  restoreHome()
  await pool.cleanup()
})

function quote(value: string): string
{
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeout = 20_000
): Promise<void>
{
  const deadline = Date.now() + timeout
  while (!(await predicate()))
  {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function shortClient(
  request?: JobRequest,
  environment: Record<string, string> = {},
  cwd?: string
): Promise<void>
{
  const moduleUrl = new URL('../../src/jobs/client.ts', import.meta.url).href
  const script = `Object.assign(process.env, JSON.parse(process.argv[1])); const client = await import(${JSON.stringify(moduleUrl)}); ${
    request
      ? 'const response = await client.controlJob(JSON.parse(process.argv[2])); if (!response.ok) throw Error(response.error);'
      : 'await client.ensureJobSupervisor();'
  }`
  const result = await execFileCommand(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      script,
      JSON.stringify(environment),
      ...(request ? [JSON.stringify(request)] : []),
    ],
    { timeout: 15_000, maxBuffer: 256_000, cwd }
  )
  assert.equal(result.ok, true, result.stderr || result.stdout)
}

async function fixture(t: TestContext): Promise<{
  root: string
  repo: string
  host: string
  toolLists: string[][]
}>
{
  const root = await pool.tempDir('coral-job-lifecycle-')
  const repo = join(root, 'repo')
  await mkdir(repo)
  process.env.CORAL_HOME = join(root, 'home')
  const git = initTestRepo(repo)
  await writeFile(join(repo, 'source.txt'), 'fixture\n')
  git('add', 'source.txt')
  assert.equal(git('commit', '-m', 'fixture').status, 0)
  const toolLists: string[][] = []
  const server = createServer(async (request, response) =>
  {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/show')
    {
      response.end(
        JSON.stringify({
          model_info: {
            'general.architecture': 'llama',
            'llama.context_length': 32768,
          },
        })
      )
      return
    }
    if (request.url === '/api/tags')
    {
      response.end(
        JSON.stringify({
          models: [
            {
              name: 'fixture:latest',
              size: 1_000_000,
              modified_at: new Date().toISOString(),
            },
          ],
        })
      )
      return
    }
    if (request.url === '/api/chat')
    {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const input = JSON.parse(body) as {
        messages?: Array<{ role: string }>
        tools?: Array<{ function: { name: string } }>
      }
      const names = input.tools?.map((tool) => tool.function.name) ?? []
      toolLists.push(names)
      const readOnly = !names.includes('write_file')
      const settled =
        readOnly || input.messages?.some((message) => message.role === 'tool')
      response.setHeader('Content-Type', 'application/x-ndjson')
      response.end(
        JSON.stringify({
          message: settled
            ? {
                role: 'assistant',
                content: readOnly
                  ? 'Inspected existing state without replaying commands.'
                  : 'Created result.txt and finished the task.',
              }
            : {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    function: {
                      name: 'write_file',
                      arguments: { path: 'result.txt', content: 'completed\n' },
                    },
                  },
                ],
              },
          done: true,
          prompt_eval_count: 10,
          eval_count: 10,
        }) + '\n'
      )
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  t.after(async () =>
  {
    const paths = jobRuntimePaths()
    const owner = readSupervisorOwner()
    if (owner && (await processIdentity(owner.pid)) === owner.identity)
    {
      process.kill(owner.pid, 'SIGTERM')
      await waitFor(
        () => !existsSync(paths.owner),
        'owned supervisor shutdown',
        15_000
      )
    }
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    await rm(paths.directory, { recursive: true, force: true })
  })
  return { root, repo, host: `http://127.0.0.1:${address.port}`, toolLists }
}

async function draft(
  repo: string,
  host: string,
  objective: string,
  setup: string[] = []
): Promise<JobRecord>
{
  const now = new Date().toISOString()
  const job: JobRecord = {
    version: 1,
    id: randomBytes(4).toString('hex'),
    createdAt: now,
    updatedAt: now,
    status: 'draft',
    consumedMs: 0,
    repairs: 0,
    commandResults: [],
    spec: {
      objective,
      model: 'fixture:latest',
      host,
      repository: await resolveJobRepository(repo),
      plan: 'Create result.txt containing completed, then verify it.',
      setup,
      checks: ['test "$(cat result.txt)" = completed'],
      activeTimeLimitMs: 60_000,
      maxRepairs: 0,
    },
  }
  writeJob(job)
  return job
}

function startRequest(job: JobRecord): JobRequest
{
  return {
    action: 'start',
    id: job.id,
    digest: jobSpecDigest(job.spec),
    hostShell: true,
  }
}

async function ready(job: JobRecord): Promise<JobRecord>
{
  await waitFor(() =>
  {
    const current = readJob(job.id)
    if (['failed', 'needs_input', 'interrupted'].includes(current.status))
    {
      assert.fail(
        `${job.id}: ${current.status}: ${current.error}\n${JSON.stringify(readJobEvents(job.id).slice(-8))}`
      )
    }
    return current.status === 'ready_for_review'
  }, `task ${job.id} to become ready for review`)
  return readJob(job.id)
}

test(
  'concurrent clients keep one supervisor and detached tasks execute in FIFO order',
  { timeout: 60_000 },
  async (t) =>
  {
    const { root, repo, host } = await fixture(t)
    const order = join(root, 'order.txt')
    const released = join(root, 'release')
    const entered = join(root, 'entered')
    const barrier = join(root, 'barrier.cjs')
    await writeFile(
      barrier,
      [
        "const fs = require('node:fs')",
        'const [root, order, entered, released] = process.argv.slice(2)',
        'const finish = () => {',
        '  if (!fs.existsSync(released)) return',
        "  fs.appendFileSync(order, 'one-end\\n')",
        '  watcher.close()',
        '}',
        'const watcher = fs.watch(root, finish)',
        "fs.appendFileSync(order, 'one-start\\n')",
        "fs.writeFileSync(entered, 'ready')",
        'finish()',
      ].join('\n')
    )
    const firstTmp = join(root, 'client-tmp-a')
    const secondTmp = join(root, 'client-tmp-b')
    const alias = join(root, 'parent-alias')
    await Promise.all([
      mkdir(firstTmp),
      mkdir(secondTmp),
      symlink(root, alias, 'dir'),
    ])
    await Promise.all([
      shortClient(undefined, { TMPDIR: firstTmp, TZ: 'UTC' }),
      shortClient(undefined, {
        TMPDIR: secondTmp,
        CORAL_HOME: join(alias, 'home'),
        TZ: 'America/New_York',
      }),
      shortClient(undefined, { CORAL_HOME: 'home' }, root),
    ])
    const owner = readSupervisorOwner()
    assert.ok(owner)
    assert.equal((await sendJobRequest({ action: 'ping' })).ok, true)
    const first = await draft(repo, host, 'First queued fixture', [
      [process.execPath, barrier, root, order, entered, released]
        .map(quote)
        .join(' '),
    ])
    const second = await draft(repo, host, 'Second queued fixture', [
      `printf 'two-start\\n' >> ${quote(order)}`,
    ])
    await shortClient(startRequest(first))
    await waitFor(() => existsSync(entered), 'first task setup barrier')
    await shortClient(startRequest(second))
    assert.equal(readJob(first.id).status, 'running')
    assert.equal(readJob(second.id).status, 'queued')
    assert.equal(readSupervisorOwner()?.token, owner.token)
    assert.equal(await processIdentity(owner.pid), owner.identity)
    assert.equal(readFileSync(order, 'utf8'), 'one-start\n')
    const activePath = jobRuntimePaths().active
    const firstWorker = JSON.parse(readFileSync(activePath, 'utf8')) as {
      jobId: string
      owner: OwnedJobProcess
    }
    assert.equal(firstWorker.jobId, first.id)

    await writeFile(released, 'continue')
    const completedFirst = await ready(first)
    assert.equal(completedFirst.settledStatus, undefined)
    assert.equal(
      await processIdentity(firstWorker.owner.pid),
      undefined,
      'task became ready before its worker exited'
    )
    assert.deepEqual(
      await ownedGroupMembers(firstWorker.owner),
      [],
      'task became ready before its owned descendants stopped'
    )
    try
    {
      assert.notEqual(
        (JSON.parse(readFileSync(activePath, 'utf8')) as { jobId: string })
          .jobId,
        first.id
      )
    }
    catch (error)
    {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const completedSecond = await ready(second)
    assert.equal(readFileSync(order, 'utf8'), 'one-start\none-end\ntwo-start\n')
    assert.equal(
      readFileSync(join(completedFirst.worktree!.path, 'result.txt'), 'utf8'),
      'completed\n'
    )
    assert.equal(
      readFileSync(join(completedSecond.worktree!.path, 'result.txt'), 'utf8'),
      'completed\n'
    )
    assert.ok(completedFirst.snapshot && completedSecond.snapshot)
    assert.notEqual(
      completedFirst.worktree!.path,
      completedSecond.worktree!.path
    )
    assert.equal(readSupervisorOwner()?.token, owner.token)
  }
)

test(
  'supervisor crashes preserve setup effects and require explicit recovery without replay',
  { timeout: 60_000 },
  async (t) =>
  {
    const { root, repo, host, toolLists } = await fixture(t)
    const effect = join(root, 'effect.txt')
    const entered = join(root, 'entered')
    const setup = join(root, 'setup.cjs')
    await writeFile(
      setup,
      [
        "const fs = require('node:fs')",
        "fs.appendFileSync(process.argv[2], 'executed\\n')",
        "fs.writeFileSync(process.argv[3], 'started')",
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )
    const job = await draft(repo, host, 'Recover interrupted setup', [
      [process.execPath, setup, effect, entered].map(quote).join(' '),
    ])
    await shortClient(startRequest(job))
    await waitFor(
      () => existsSync(entered) && readJob(job.id).consumedMs >= 1000,
      'setup side effect and durable active-time heartbeat'
    )
    const beforeCrash = readJob(job.id)
    const owner = readSupervisorOwner()
    assert.ok(owner)
    assert.equal(await processIdentity(owner.pid), owner.identity)
    process.kill(owner.pid, 'SIGKILL')
    await waitFor(
      async () => (await processIdentity(owner.pid)) !== owner.identity,
      'terminated original supervisor'
    )

    await shortClient()
    await waitFor(
      () => readJob(job.id).status === 'interrupted',
      'recovered interrupted state'
    )
    const interrupted = readJob(job.id)
    assert.notEqual(readSupervisorOwner()?.token, owner.token)
    assert.equal(readFileSync(effect, 'utf8'), 'executed\n')
    assert.equal(interrupted.pendingCommand?.command, job.spec.setup[0])
    assert.ok(interrupted.consumedMs >= beforeCrash.consumedMs)
    assert.equal(interrupted.repairs, beforeCrash.repairs)
    assert.equal(
      interrupted.spec.activeTimeLimitMs,
      beforeCrash.spec.activeTimeLimitMs
    )
    assert.equal(toolLists.length, 0)

    await controlJob({
      action: 'resume',
      id: job.id,
      instructions: 'Inspect the existing setup effects and continue safely.',
    })
    await waitFor(
      () => readJob(job.id).status === 'needs_input',
      'explicit setup-resolution request'
    )
    const unresolved = readJob(job.id)
    assert.match(unresolved.error ?? '', /explicit setup resolution/)
    assert.equal(readFileSync(effect, 'utf8'), 'executed\n')
    assert.ok(toolLists.length > 0)
    assert.ok(
      toolLists.every(
        (names) => !names.includes('write_file') && !names.includes('bash')
      )
    )
    assert.equal(
      existsSync(join(unresolved.worktree!.path, 'result.txt')),
      false
    )
    assert.ok(unresolved.consumedMs >= interrupted.consumedMs)
    assert.equal(unresolved.repairs, interrupted.repairs)

    await controlJob({
      action: 'resume',
      id: job.id,
      instructions:
        'Keep the existing setup effects and finish the approved task.',
      setupResolution: 'skip',
    })
    const completed = await ready(job)
    assert.equal(completed.setupCompleted, 1)
    assert.equal(completed.pendingCommand, undefined)
    assert.equal(readFileSync(effect, 'utf8'), 'executed\n')
    assert.equal(
      readFileSync(join(completed.worktree!.path, 'result.txt'), 'utf8'),
      'completed\n'
    )
    assert.ok(completed.consumedMs >= unresolved.consumedMs)
    assert.equal(completed.repairs, unresolved.repairs)
    assert.ok(
      completed.commandResults
        .filter((command) => command.phase === 'checks')
        .every((command) => command.ok)
    )
  }
)

test(
  'draft cancellation stays unapproved and failed queue persistence cannot start execution',
  { timeout: 30_000 },
  async (t) =>
  {
    const { repo, host } = await fixture(t)
    const cancelled = await draft(repo, host, 'Cancel this unapproved draft')
    await controlJob({ action: 'cancel', id: cancelled.id })
    const cancelledRecord = readJob(cancelled.id)
    assert.equal(cancelledRecord.status, 'cancelled')
    assert.equal(cancelledRecord.approval, undefined)
    assert.equal(cancelledRecord.worktree, undefined)

    const blocked = await draft(
      repo,
      host,
      'Do not execute when persistence fails'
    )
    await writeFile(
      join(jobDirectory(blocked.id), 'events.json'),
      JSON.stringify({ invalid: 'event stream must be an array' })
    )
    await assert.rejects(
      controlJob({
        action: 'start',
        id: blocked.id,
        digest: jobSpecDigest(blocked.spec),
        hostShell: true,
      }),
      /task events|storage|blocked/i
    )
    const unchanged = readJob(blocked.id)
    assert.equal(unchanged.status, 'draft')
    assert.equal(unchanged.approval, undefined)
    assert.equal(unchanged.worktree, undefined)
    assert.equal(existsSync(join(jobDirectory(blocked.id), 'worktree')), false)
    const ping = await sendJobRequest({ action: 'ping' })
    assert.equal(ping.ok, false)
    assert.match(ping.error ?? '', /task events|storage|blocked/i)
  }
)

test(
  'cancelling a running task joins its descendants before the next queued worker starts',
  { timeout: 60_000 },
  async (t) =>
  {
    const { root, repo, host } = await fixture(t)
    const entered = join(root, 'entered.json')
    const tree = join(root, 'tree.cjs')
    await writeFile(
      tree,
      [
        "const { fork } = require('node:child_process')",
        "const fs = require('node:fs')",
        'const entered = process.argv[2]',
        "process.on('SIGTERM', () => {})",
        'setInterval(() => {}, 1000)',
        "if (process.argv[3] === 'child') process.send(process.pid)",
        'else {',
        "  const child = fork(__filename, [entered, 'child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })",
        "  child.once('message', pid => fs.writeFileSync(entered, JSON.stringify([process.pid, pid])))",
        '}',
      ].join('\n')
    )
    const checkStopped = join(root, 'check-stopped.cjs')
    await writeFile(
      checkStopped,
      [
        "const { execFileSync } = require('node:child_process')",
        "const fs = require('node:fs')",
        'const pids = JSON.parse(fs.readFileSync(process.argv[2]))',
        "const rows = execFileSync('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'stat='], { encoding: 'utf8' }).trim().split('\\n')",
        'for (const row of rows) {',
        '  const [pid, state] = row.trim().split(/\\s+/)',
        "  if (pids.includes(Number(pid)) && !state.startsWith('Z')) throw Error('previous task process still running')",
        '}',
        "fs.writeFileSync('previous-stopped.txt', 'proved')",
      ].join('\n')
    )
    const first = await draft(repo, host, 'Cancelled fixture', [
      [process.execPath, tree, entered].map(quote).join(' '),
    ])
    const second = await draft(repo, host, 'Next fixture', [
      [process.execPath, checkStopped, entered].map(quote).join(' '),
    ])
    await shortClient(startRequest(first))
    await waitFor(() => existsSync(entered), 'running task descendant barrier')
    await shortClient(startRequest(second))
    assert.equal(readJob(second.id).status, 'queued')
    await controlJob({ action: 'cancel', id: first.id })
    const next = await ready(second)
    assert.equal(readJob(first.id).status, 'cancelled')
    assert.equal(
      readFileSync(join(next.worktree!.path, 'previous-stopped.txt'), 'utf8'),
      'proved'
    )
    assert.equal(next.commandResults[0].ok, true)
  }
)
