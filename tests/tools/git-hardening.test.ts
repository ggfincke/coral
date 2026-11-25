// tests/tools/git-hardening.test.ts
// git tools ignore config-driven commands, report cut output, & refuse refspecs

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildGitContextMessage } from '../../src/agent/request/git-context.js'
import {
  gitCommitTool,
  gitDiffTool,
  gitPushTool,
  gitStatusTool,
} from '../../src/tools/git.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { HAS_GIT, initTestRepo } from '../helpers/git.js'

const { tempDir } = makeTempDirPool()

function toolContext(cwd: string)
{
  return { cwd, ollamaHost: 'http://unused' }
}

// marker script that records it ran, so a test can prove git never invoked it
async function markerScript(dir: string, name: string): Promise<string>
{
  const script = join(dir, `${name}.sh`)
  await writeFile(script, `#!/bin/sh\ntouch "${join(dir, `${name}.ran`)}"\n`)
  await chmod(script, 0o755)
  return script
}

async function committedRepo(prefix: string)
{
  const dir = await tempDir(prefix)
  const run = initTestRepo(dir)
  await writeFile(join(dir, 'a.txt'), 'one\n')
  assert.equal(run('add', '-A').status, 0)
  assert.equal(run('commit', '-m', 'base').status, 0)
  return { dir, run }
}

test(
  'read-side git ignores repo-local fsmonitor, diff.external, & color',
  { skip: !HAS_GIT },
  async () =>
  {
    const { dir, run } = await committedRepo('coral-git-config-')
    run('config', 'core.fsmonitor', await markerScript(dir, 'fsmonitor'))
    run('config', 'diff.external', await markerScript(dir, 'extdiff'))
    run('config', 'color.ui', 'always')
    await writeFile(join(dir, 'a.txt'), 'two\n')

    const context = await buildGitContextMessage(dir)
    const status = await gitStatusTool.execute({}, toolContext(dir))
    const diff = await gitDiffTool.execute({}, toolContext(dir))

    assert.ok(context)
    assert.equal(existsSync(join(dir, 'fsmonitor.ran')), false)
    assert.equal(existsSync(join(dir, 'extdiff.ran')), false)
    assert.match(status.output, /^ M a\.txt$/m)
    assert.match(diff.output, /^\+two$/m)
    assert.equal(`${status.output}${diff.output}`.includes('\u001b['), false)
  }
)

test(
  'an approved git_commit still runs repository hooks',
  { skip: !HAS_GIT },
  async () =>
  {
    const { dir, run } = await committedRepo('coral-git-hook-')
    const hook = join(dir, '.git', 'hooks', 'pre-commit')
    await writeFile(hook, `#!/bin/sh\ntouch "${join(dir, 'hook.ran')}"\n`)
    await chmod(hook, 0o755)
    await writeFile(join(dir, 'a.txt'), 'two\n')
    assert.equal(run('add', '-A').status, 0)

    const result = await gitCommitTool.execute(
      { message: 'hooked' },
      toolContext(dir)
    )

    assert.equal(result.error, undefined)
    assert.equal(existsSync(join(dir, 'hook.ran')), true)
  }
)

test(
  'git_diff over the output buffer reports truncation, not a partial diff',
  { skip: !HAS_GIT },
  async () =>
  {
    const { dir } = await committedRepo('coral-git-bigdiff-')
    const lines = Array.from(
      { length: 40_000 },
      (_, index) => `line ${index} ${'y'.repeat(40)}`
    )
    await writeFile(join(dir, 'a.txt'), `${lines.join('\n')}\n`)

    const diff = await gitDiffTool.execute({}, toolContext(dir))

    assert.equal(diff.output, '')
    assert.match(diff.error ?? '', /exceeded \d+ bytes and was cut off/)
  }
)

test(
  'git_push refuses refspecs & unconfigured remotes but pushes a plain branch',
  { skip: !HAS_GIT },
  async () =>
  {
    const bare = await tempDir('coral-git-bare-')
    assert.equal(spawnSync('git', ['init', '--bare', bare]).status, 0)
    const { dir, run } = await committedRepo('coral-git-push-')
    assert.equal(run('switch', '-c', 'feat/x').status, 0)
    assert.equal(run('remote', 'add', 'origin', bare).status, 0)

    for (const branch of [':main', '+main', 'HEAD:main'])
    {
      const result = await gitPushTool.execute(
        { remote: 'origin', branch },
        toolContext(dir)
      )
      assert.match(result.error ?? '', /Invalid branch/, branch)
    }
    const pathRemote = await gitPushTool.execute(
      { remote: bare, branch: 'feat/x' },
      toolContext(dir)
    )
    assert.match(pathRemote.error ?? '', /Unknown remote/)
    const before = spawnSync('git', ['-C', bare, 'branch', '--list'], {
      encoding: 'utf-8',
    })
    assert.equal(before.stdout.trim(), '')

    const pushed = await gitPushTool.execute(
      { remote: 'origin', branch: 'feat/x', setUpstream: true },
      toolContext(dir)
    )
    const upstream = run('rev-parse', '--abbrev-ref', '@{u}')

    assert.equal(pushed.error, undefined)
    assert.equal(upstream.stdout.trim(), 'origin/feat/x')
  }
)
