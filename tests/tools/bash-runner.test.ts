// tests/tools/bash-runner.test.ts
// bash & mutating git stop whole process groups, report why, & hide hosted keys

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { runJobCommand } from '../../src/jobs/process.js'
import { bashTool } from '../../src/tools/bash.js'
import { capErrorMessage } from '../../src/tools/tool-output.js'
import { runGitCommand } from '../../src/utils/git.js'
import { HAS_GIT, initTestRepo } from '../helpers/git.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

function toolContext(cwd: string, signal?: AbortSignal)
{
  return { cwd, ollamaHost: 'http://unused', signal }
}

// a sleep duration no other test or process uses, so pgrep finds only ours
function uniqueSleep(): string
{
  return `${30 + Math.floor(Math.random() * 1000)}.${process.pid % 1000}`
}

function survivors(sleep: string): string
{
  return spawnSync('pgrep', ['-f', `^sleep ${sleep.replace('.', '\\.')}$`], {
    encoding: 'utf-8',
  }).stdout.trim()
}

test('bash timeout stops the whole command & says so', async () =>
{
  const dir = await tempDir('coral-bash-timeout-')
  const sleep = uniqueSleep()
  const startedAt = Date.now()
  const result = await bashTool.execute(
    { command: `sleep ${sleep}; echo done`, timeout: 200 },
    toolContext(dir)
  )

  assert.ok(Date.now() - startedAt < 5000)
  assert.match(result.error ?? '', /timed out after 200 ms/)
  assert.equal(survivors(sleep), '')
})

test('bash abort stops a compound command & its children', async () =>
{
  const dir = await tempDir('coral-bash-abort-group-')
  const sleep = uniqueSleep()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const result = await bashTool.execute(
    { command: `sleep ${sleep}; echo done` },
    toolContext(dir, controller.signal)
  )

  assert.match(result.error ?? '', /cancelled/)
  assert.equal(survivors(sleep), '')
})

test('bash reports exit codes & refuses bad timeouts', async () =>
{
  const dir = await tempDir('coral-bash-exit-')
  const exit = await bashTool.execute({ command: 'exit 3' }, toolContext(dir))
  assert.equal(exit.error, '[exit code 3]')

  for (const timeout of [0, -1, 1.5])
  {
    const refused = await bashTool.execute(
      { command: 'true', timeout },
      toolContext(dir)
    )
    assert.match(refused.error ?? '', /bash timeout must be a whole number/)
  }
})

test('bash gives children no stdin', async () =>
{
  const dir = await tempDir('coral-bash-stdin-')
  const startedAt = Date.now()
  const result = await bashTool.execute(
    { command: 'cat', timeout: 5000 },
    toolContext(dir)
  )

  assert.ok(Date.now() - startedAt < 2000)
  assert.equal(result.error, undefined)
  assert.equal(result.output, '')
})

test('bash keeps running past the output cap & keeps head & tail', async () =>
{
  const dir = await tempDir('coral-bash-overflow-')
  const result = await bashTool.execute(
    {
      command:
        'echo FIRST-LINE; head -c 2097152 /dev/zero | tr "\\0" x; echo; echo LAST-LINE; touch marker',
    },
    toolContext(dir)
  )

  assert.equal(result.error, undefined)
  assert.ok(existsSync(join(dir, 'marker')))
  assert.match(result.output, /^FIRST-LINE\n/)
  assert.match(result.output, /\n\[\d+ chars of output omitted\]\n/)
  assert.match(result.output, /LAST-LINE\n$/)
})

test('bash failure cause survives the model-facing error cap', async () =>
{
  const dir = await tempDir('coral-bash-long-stderr-')
  // ~10 KB of stderr, past the loop's 8,000-char error cap
  const noise = 'for i in $(seq 1 400); do echo "FAIL test $i" >&2; done'
  const cases = [
    { command: `${noise}; sleep 5`, timeout: 1000, cause: /timed out/ },
    { command: `${noise}; exit 2`, timeout: 5000, cause: /exit code 2/ },
  ]
  for (const { command, timeout, cause } of cases)
  {
    const result = await bashTool.execute(
      { command, timeout },
      toolContext(dir)
    )
    const seen = capErrorMessage(result.error ?? '')
    assert.match(seen, cause)
    assert.match(seen, /FAIL test 1\n/)
    assert.match(seen, /FAIL test 400$/)
  }
})

test('bash & task commands do not inherit hosted API keys', async () =>
{
  const dir = await tempDir('coral-child-env-')
  const saved = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-test-secret'
  try
  {
    const command =
      'printf "key=%s path=%s" "$ANTHROPIC_API_KEY" "${PATH:+set}"'
    const bash = await bashTool.execute({ command }, toolContext(dir))
    assert.equal(bash.output, 'key= path=set')

    const task = await runJobCommand(command, { cwd: dir })
    assert.equal(task.output, 'key= path=set')
  }
  finally
  {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  }
})

test(
  'mutating git timeout names the timeout & stops its hooks',
  { skip: !HAS_GIT },
  async () =>
  {
    const dir = await tempDir('coral-git-hook-timeout-')
    initTestRepo(dir)
    const sleep = uniqueSleep()
    const hook = join(dir, '.git', 'hooks', 'pre-commit')
    await writeFile(
      hook,
      `#!/bin/sh\necho "lint running" >&2\nsleep ${sleep}\n`
    )
    await chmod(hook, 0o755)
    await writeFile(join(dir, 'a.txt'), 'one\n')
    spawnSync('git', ['add', 'a.txt'], { cwd: dir })

    const result = await runGitCommand(['commit', '-m', 'slow'], dir, {
      timeout: 500,
    })

    assert.match(result.error ?? '', /^git did not finish within 500 ms\n/)
    assert.match(result.error ?? '', /lint running/)
    assert.equal(survivors(sleep), '')
  }
)
