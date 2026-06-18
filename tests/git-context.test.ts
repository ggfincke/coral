// tests/git-context.test.ts
// tests for volatile git workflow context

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  buildGitContextMessage,
  GIT_CONTEXT_HEADING,
} from '../src/agent/git-context.js'

const tempDirs: string[] = []
const hasGit = spawnSync('git', ['--version']).status === 0

after(async () =>
{
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

test(
  'buildGitContextMessage includes staged, unstaged, and untracked files',
  { skip: !hasGit },
  async () =>
  {
    const dir = await mkdtemp(join(tmpdir(), 'coral-git-context-'))
    tempDirs.push(dir)
    assert.equal(spawnSync('git', ['init'], { cwd: dir }).status, 0)
    assert.equal(
      spawnSync('git', ['config', 'user.email', 'test@coral.dev'], {
        cwd: dir,
      }).status,
      0
    )
    assert.equal(
      spawnSync('git', ['config', 'user.name', 'Coral Test'], { cwd: dir })
        .status,
      0
    )
    await writeFile(join(dir, 'tracked.txt'), 'one\n', 'utf-8')
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: dir }).status, 0)
    assert.equal(
      spawnSync('git', ['commit', '-m', 'init'], { cwd: dir }).status,
      0
    )

    await writeFile(join(dir, 'tracked.txt'), 'two\n', 'utf-8')
    await writeFile(join(dir, 'staged.txt'), 'staged\n', 'utf-8')
    await writeFile(join(dir, 'untracked.txt'), 'untracked\n', 'utf-8')
    assert.equal(
      spawnSync('git', ['add', 'staged.txt'], { cwd: dir }).status,
      0
    )

    const message = await buildGitContextMessage(dir)

    assert.ok(message)
    assert.equal(message.role, 'system')
    assert.ok(message.content.startsWith(GIT_CONTEXT_HEADING))
    assert.match(
      message.content,
      /status: dirty \(1 staged, 1 unstaged, 1 untracked\)/
    )
    assert.match(message.content, /staged\.txt/)
    assert.match(message.content, /tracked\.txt/)
    assert.match(message.content, /untracked\.txt/)
  }
)

// guards the --git-path resolution: operation markers must be checked against
// the repo's cwd, not the test process cwd (which is never mid-merge)
test(
  'buildGitContextMessage detects an in-progress merge in a non-cwd repo',
  { skip: !hasGit },
  async () =>
  {
    const dir = await mkdtemp(join(tmpdir(), 'coral-git-merge-'))
    tempDirs.push(dir)
    const run = (...args: string[]) =>
      spawnSync('git', args, { cwd: dir, encoding: 'utf-8' })

    assert.equal(run('init').status, 0)
    assert.equal(run('config', 'user.email', 'test@coral.dev').status, 0)
    assert.equal(run('config', 'user.name', 'Coral Test').status, 0)

    await writeFile(join(dir, 'file.txt'), 'base\n', 'utf-8')
    assert.equal(run('add', '-A').status, 0)
    assert.equal(run('commit', '-m', 'base').status, 0)

    assert.equal(run('switch', '-c', 'other').status, 0)
    await writeFile(join(dir, 'file.txt'), 'other\n', 'utf-8')
    assert.equal(run('commit', '-am', 'other').status, 0)

    assert.equal(run('switch', '-').status, 0)
    await writeFile(join(dir, 'file.txt'), 'main\n', 'utf-8')
    assert.equal(run('commit', '-am', 'main').status, 0)

    // divergent edits to the same line force a conflict, leaving MERGE_HEAD
    run('merge', 'other')
    assert.ok(existsSync(join(dir, '.git', 'MERGE_HEAD')))

    const message = await buildGitContextMessage(dir)

    assert.ok(message)
    assert.match(message.content, /operation: merge/)
  }
)

test(
  'buildGitContextMessage reports unknown status when git status fails',
  { skip: !hasGit },
  async () =>
  {
    const dir = await mkdtemp(join(tmpdir(), 'coral-git-status-error-'))
    tempDirs.push(dir)
    const run = (...args: string[]) =>
      spawnSync('git', args, { cwd: dir, encoding: 'utf-8' })

    assert.equal(run('init').status, 0)
    assert.equal(run('config', 'user.email', 'test@coral.dev').status, 0)
    assert.equal(run('config', 'user.name', 'Coral Test').status, 0)

    await writeFile(join(dir, 'tracked.txt'), 'base\n', 'utf-8')
    assert.equal(run('add', '-A').status, 0)
    assert.equal(run('commit', '-m', 'base').status, 0)
    await writeFile(join(dir, '.git', 'index'), 'not a git index\n', 'utf-8')

    const message = await buildGitContextMessage(dir)

    assert.ok(message)
    assert.match(message.content, /status: unknown/)
    assert.match(message.content, /staged files: unknown/)
    assert.doesNotMatch(message.content, /status: clean/)
  }
)
