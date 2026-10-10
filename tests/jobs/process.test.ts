// tests/jobs/process.test.ts
// join owned shell descendants on cancellation and deadlines before later work

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  cleanupJobProcesses,
  ownedGroupMembers,
  processIdentity,
  runJobCommand,
  terminateOwnedGroup,
  type OwnedJobProcess,
} from '../../src/jobs/process.js'
import { jobDirectory } from '../../src/jobs/store.js'
import { execFileCommand } from '../../src/utils/process.js'
import { captureCoralHome } from '../helpers/coral-home.js'
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

async function waitForFile(path: string): Promise<void>
{
  const deadline = Date.now() + 10_000
  while (!existsSync(path))
  {
    assert.ok(
      Date.now() < deadline,
      `Timed out waiting for command barrier: ${path}`
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function fixture(): Promise<{
  root: string
  id: string
  command: string
  ready: string
}>
{
  const root = await pool.tempDir('coral-job-process-')
  process.env.CORAL_HOME = join(root, 'home')
  const script = join(root, 'tree.cjs')
  const ready = join(root, 'ready.json')
  await writeFile(
    script,
    [
      "const { fork } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      'const depth = Number(process.argv[2])',
      'const ready = process.argv[3]',
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 1000)',
      'if (depth === 2) process.send([process.pid])',
      'else {',
      "  const child = fork(__filename, [String(depth + 1), ready], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })",
      "  child.once('message', pids => {",
      '    const members = [process.pid, ...pids]',
      '    if (depth === 0) writeFileSync(ready, JSON.stringify(members))',
      '    else process.send(members)',
      '  })',
      '}',
    ].join('\n')
  )
  return {
    root,
    id: randomBytes(4).toString('hex'),
    command: `${quote(process.execPath)} ${quote(script)} 0 ${quote(ready)}`,
    ready,
  }
}

function ownerFor(id: string): OwnedJobProcess
{
  const directory = join(jobDirectory(id), 'processes')
  const files = readdirSync(directory).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 1)
  return JSON.parse(
    readFileSync(join(directory, files[0]), 'utf8')
  ) as OwnedJobProcess
}

test(
  'cancellation rejects uncertain identity and joins stubborn children and grandchildren',
  { timeout: 20_000 },
  async () =>
  {
    const fixtureData = await fixture()
    const { root, id, command, ready } = fixtureData
    const bashEnv = join(root, 'bash-env.sh')
    const startup = join(root, 'startup.txt')
    const early = join(root, 'early-startup.txt')
    await writeFile(
      bashEnv,
      [
        'coral_journal_found=',
        `for coral_journal in ${quote(join(jobDirectory(id), 'processes'))}/*.json; do`,
        '  if [ -f "$coral_journal" ]; then coral_journal_found=yes; break; fi',
        'done',
        'if [ "$coral_journal_found" != yes ]; then',
        `  printf early > ${quote(early)}`,
        '  exit 98',
        'fi',
        `printf recorded > ${quote(startup)}`,
      ].join('\n')
    )
    const previousBashEnv = process.env.BASH_ENV
    process.env.BASH_ENV = bashEnv
    const abort = new AbortController()
    // explicit sourcing exercises the journal check even when Bash ignores BASH_ENV
    const running = runJobCommand(`. ${quote(bashEnv)}; ${command}`, {
      cwd: root,
      signal: abort.signal,
      jobId: id,
    })
    void running.catch(() =>
    {})
    try
    {
      await waitForFile(ready)
      assert.equal(
        existsSync(early),
        false,
        'shell startup ran before its launch journal'
      )
      assert.equal(readFileSync(startup, 'utf8'), 'recorded')
      const children = JSON.parse(readFileSync(ready, 'utf8')) as number[]
      assert.equal(children.length, 3)
      const owner = ownerFor(id)
      const members = await ownedGroupMembers(owner)
      assert.ok(children.every((pid) => members.includes(pid)))
      await assert.rejects(
        terminateOwnedGroup({
          ...owner,
          identity: 'unproven owner',
          token: randomUUID(),
        }),
        /ownership/
      )
      assert.ok((await ownedGroupMembers(owner)).length >= 3)
      if (owner.bootId)
      {
        await terminateOwnedGroup({ ...owner, bootId: randomUUID() })
        assert.ok((await ownedGroupMembers(owner)).length >= 3)
      }

      abort.abort()
      const result = await running
      assert.equal(result.ok, false)
      assert.match(result.output, /cancelled/)
      assert.deepEqual(await ownedGroupMembers(owner), [])
      assert.deepEqual(readdirSync(join(jobDirectory(id), 'processes')), [])
      const next = await runJobCommand('printf settled > next.txt', {
        cwd: root,
        jobId: id,
      })
      assert.equal(next.ok, true)
      assert.equal(readFileSync(join(root, 'next.txt'), 'utf8'), 'settled')
    }
    finally
    {
      abort.abort()
      await running.catch(() =>
      {})
      await cleanupJobProcesses(id)
      if (previousBashEnv === undefined) delete process.env.BASH_ENV
      else process.env.BASH_ENV = previousBashEnv
    }
  }
)

test(
  'command deadlines settle an entire process tree and keep failure evidence',
  { timeout: 20_000 },
  async () =>
  {
    const { root, id, command, ready } = await fixture()
    const abort = new AbortController()
    const running = runJobCommand(command, {
      cwd: root,
      jobId: id,
      signal: abort.signal,
      timeoutMs: 2500,
    })
    void running.catch(() =>
    {})
    try
    {
      await waitForFile(ready)
      const owner = ownerFor(id)
      const result = await running
      assert.equal(result.ok, false)
      assert.match(result.output, /deadline expired/)
      assert.deepEqual(await ownedGroupMembers(owner), [])
      assert.deepEqual(readdirSync(join(jobDirectory(id), 'processes')), [])
    }
    finally
    {
      abort.abort()
      await running.catch(() =>
      {})
      await cleanupJobProcesses(id)
    }
  }
)

test(
  'foreground completion rejects and stops descendants that detach into another session',
  { timeout: 20_000 },
  async () =>
  {
    const root = await pool.tempDir('coral-job-detached-')
    process.env.CORAL_HOME = join(root, 'home')
    const id = randomBytes(4).toString('hex')
    const script = join(root, 'detach.cjs')
    const evidencePath = join(root, 'launched.json')
    const directory = join(jobDirectory(id), 'processes')
    await writeFile(
      script,
      [
        "const { spawn, execFileSync } = require('node:child_process')",
        "const fs = require('node:fs')",
        "const path = require('node:path')",
        'const [directory, evidencePath] = process.argv.slice(2)',
        "const journal = fs.readdirSync(directory).find(name => name.endsWith('.json'))",
        'const owner = JSON.parse(fs.readFileSync(path.join(directory, journal)))',
        "const child = spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' })",
        "child.once('spawn', () => {",
        "  const identity = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart=', '-o', 'pgid='], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).trim()",
        '  fs.writeFileSync(evidencePath, JSON.stringify({ owner, pid: child.pid, identity }))',
        "  console.log('launcher finished successfully')",
        '  child.unref()',
        '})',
      ].join('\n')
    )
    let evidence:
      { owner: OwnedJobProcess; pid: number; identity: string } | undefined
    try
    {
      const result = await runJobCommand(
        [process.execPath, script, directory, evidencePath]
          .map(quote)
          .join(' '),
        { cwd: root, jobId: id }
      )
      evidence = JSON.parse(
        readFileSync(evidencePath, 'utf8')
      ) as typeof evidence
      assert.ok(evidence)
      assert.notEqual(evidence.pid, evidence.owner.pid)
      assert.equal(Number(evidence.identity.split(/\s+/).at(-1)), evidence.pid)
      assert.equal(result.ok, false)
      assert.match(result.output, /launcher finished successfully/)
      assert.match(result.output, /Background descendants were stopped/)
      const state = await execFileCommand('/bin/ps', [
        '-p',
        String(evidence.pid),
        '-o',
        'stat=',
      ])
      assert.ok(
        !state.stdout.trim() || state.stdout.trim().startsWith('Z'),
        'detached descendant remained live after command settlement'
      )
      assert.deepEqual(await ownedGroupMembers(evidence.owner), [])
      assert.deepEqual(readdirSync(directory), [])
    }
    finally
    {
      if (!evidence && existsSync(evidencePath))
      {
        evidence = JSON.parse(
          readFileSync(evidencePath, 'utf8')
        ) as typeof evidence
      }
      if (
        evidence &&
        (await processIdentity(evidence.pid)) === evidence.identity
      )
      {
        process.kill(evidence.pid, 'SIGKILL')
      }
      await cleanupJobProcesses(id)
    }
  }
)
