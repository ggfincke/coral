// tests/tools/git-hardening.test.ts
// git tools ignore config-driven commands, report cut output, & refuse unsafe pushes

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, chmod, writeFile } from 'node:fs/promises'
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
  'read-side git runs no config-defined hook or filter driver',
  { skip: !HAS_GIT },
  async () =>
  {
    const { dir, run } = await committedRepo('coral-git-cfg-hook-')
    await writeFile(join(dir, '.gitattributes'), '* filter=marker\n')
    run('config', 'hook.marker.command', await markerScript(dir, 'hook'))
    run('config', 'hook.marker.event', 'post-index-change')
    run('config', 'filter.marker.clean', await markerScript(dir, 'clean'))
    run('config', 'filter.marker.required', 'true')
    await writeFile(join(dir, 'a.txt'), 'two\n')

    const context = await buildGitContextMessage(dir)
    const status = await gitStatusTool.execute({}, toolContext(dir))
    const diff = await gitDiffTool.execute({}, toolContext(dir))
    const stat = await gitDiffTool.execute({ stat: true }, toolContext(dir))

    assert.ok(context)
    assert.equal(existsSync(join(dir, 'hook.ran')), false)
    assert.equal(existsSync(join(dir, 'clean.ran')), false)
    assert.match(status.output, /^ M a\.txt$/m)
    assert.match(diff.output, /^\+two$/m)
    assert.match(stat.output, /a\.txt/)
  }
)

test(
  'read-side git fails cleanly on a hook or filter config too large to override',
  { skip: !HAS_GIT },
  async () =>
  {
    const { dir } = await committedRepo('coral-git-cfg-many-')
    const config = join(dir, '.git', 'config')
    const hook = await markerScript(dir, 'hook')
    const hooks = Array.from(
      { length: 2000 },
      (_, index) =>
        `[hook "h${index}"]\n\tcommand = ${hook}\n\tevent = post-index-change\n`
    )
    await appendFile(config, hooks.join(''))
    await writeFile(join(dir, 'a.txt'), 'two\n')

    // many hook names on one event need a single event-level override
    const hooked = await gitStatusTool.execute({}, toolContext(dir))
    assert.equal(hooked.error, undefined)
    assert.match(hooked.output, /^ M a\.txt$/m)

    const clean = await markerScript(dir, 'clean')
    await writeFile(join(dir, '.gitattributes'), '* filter=f0\n')
    const filters = Array.from(
      { length: 3000 },
      (_, index) => `[filter "f${index}"]\n\tclean = ${clean}\n`
    )
    await appendFile(config, filters.join(''))
    await writeFile(join(dir, 'a.txt'), 'three\n')

    const status = await gitStatusTool.execute({}, toolContext(dir))
    const context = await buildGitContextMessage(dir)

    assert.match(status.error ?? '', /too many hook or filter entries/)
    assert.equal(context, null)
    assert.equal(existsSync(join(dir, 'hook.ran')), false)
    assert.equal(existsSync(join(dir, 'clean.ran')), false)
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
    run('config', 'hook.marker.command', await markerScript(dir, 'cfghook'))
    run('config', 'hook.marker.event', 'pre-commit')
    await writeFile(join(dir, 'a.txt'), 'two\n')
    assert.equal(run('add', '-A').status, 0)

    const result = await gitCommitTool.execute(
      { message: 'hooked' },
      toolContext(dir)
    )

    assert.equal(result.error, undefined)
    assert.equal(existsSync(join(dir, 'hook.ran')), true)
    assert.equal(existsSync(join(dir, 'cfghook.ran')), true)
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

test('git_push refuses a mirror remote', { skip: !HAS_GIT }, async () =>
{
  const bare = await tempDir('coral-git-mirror-')
  assert.equal(spawnSync('git', ['init', '--bare', bare]).status, 0)
  const { dir, run } = await committedRepo('coral-git-mirror-push-')
  assert.equal(run('remote', 'add', 'origin', bare).status, 0)
  assert.equal(run('config', 'remote.origin.mirror', 'true').status, 0)

  const named = await gitPushTool.execute(
    { remote: 'origin' },
    toolContext(dir)
  )
  const implicit = await gitPushTool.execute({}, toolContext(dir))
  const refs = spawnSync('git', ['-C', bare, 'for-each-ref'], {
    encoding: 'utf-8',
  })

  assert.match(named.error ?? '', /mirror remote/)
  assert.match(implicit.error ?? '', /mirror remote/)
  assert.equal(refs.stdout.trim(), '')
})
