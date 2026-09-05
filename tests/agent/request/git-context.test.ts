// tests/agent/request/git-context.test.ts
// tests for volatile git workflow context

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  buildGitContextMessage,
  GIT_CONTEXT_HEADING,
} from '../../../src/agent/request/git-context.js'
import { makeTempDirPool } from '../../helpers/temp.js'
import { HAS_GIT, initTestRepo } from '../../helpers/git.js'

const { tempDir } = makeTempDirPool()

test(
  'buildGitContextMessage includes staged, unstaged, and untracked files',
  { skip: !HAS_GIT },
  async () =>
  {
    const dir = await tempDir('coral-git-context-')
    const run = initTestRepo(dir)
    await writeFile(join(dir, 'tracked.txt'), 'one\n', 'utf-8')
    assert.equal(run('add', '-A').status, 0)
    assert.equal(run('commit', '-m', 'init').status, 0)

    await writeFile(join(dir, 'tracked.txt'), 'two\n', 'utf-8')
    await writeFile(join(dir, 'staged.txt'), 'staged\n', 'utf-8')
    await writeFile(join(dir, 'untracked.txt'), 'untracked\n', 'utf-8')
    assert.equal(run('add', 'staged.txt').status, 0)

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
  { skip: !HAS_GIT },
  async () =>
  {
    const dir = await tempDir('coral-git-merge-')
    const run = initTestRepo(dir)

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
  'git operation markers stay local to their linked worktree',
  { skip: !HAS_GIT },
  async () =>
  {
    const dir = await tempDir('coral-git-context-worktree-')
    const run = initTestRepo(dir)
    await writeFile(join(dir, 'tracked.txt'), 'base\n', 'utf-8')
    assert.equal(run('add', '-A').status, 0)
    assert.equal(run('commit', '-m', 'base').status, 0)

    const worktree = join(await tempDir('coral-git-context-linked-'), 'linked')
    assert.equal(run('worktree', 'add', '-b', 'linked', worktree).status, 0)
    const head = run('rev-parse', 'HEAD').stdout.trim()
    await writeFile(join(dir, '.git', 'MERGE_HEAD'), `${head}\n`, 'utf-8')
    const marker = run(
      '-C',
      worktree,
      'rev-parse',
      '--git-path',
      'CHERRY_PICK_HEAD'
    )
    assert.equal(marker.status, 0)
    await writeFile(
      resolve(worktree, marker.stdout.trimEnd()),
      `${head}\n`,
      'utf-8'
    )

    const [primary, linked] = await Promise.all([
      buildGitContextMessage(dir),
      buildGitContextMessage(worktree),
    ])
    assert.ok(primary)
    assert.ok(linked)
    assert.match(primary.content, /operation: merge\n/)
    assert.match(linked.content, /operation: cherry-pick\n/)
  }
)

test(
  'git operation markers fall back when repository paths contain newlines',
  { skip: !HAS_GIT || process.platform === 'win32' },
  async () =>
  {
    const dir = await tempDir('coral-git-context-multiline-\n')
    const run = initTestRepo(dir)
    await writeFile(join(dir, 'tracked.txt'), 'base\n', 'utf-8')
    assert.equal(run('add', '-A').status, 0)
    assert.equal(run('commit', '-m', 'base').status, 0)
    const head = run('rev-parse', 'HEAD').stdout.trim()
    await writeFile(join(dir, '.git', 'MERGE_HEAD'), `${head}\n`, 'utf-8')

    const message = await buildGitContextMessage(dir)

    assert.ok(message)
    assert.match(message.content, /operation: merge\n/)
  }
)

test(
  'buildGitContextMessage reports unknown status when git status fails',
  { skip: !HAS_GIT },
  async () =>
  {
    const dir = await tempDir('coral-git-status-error-')
    const run = initTestRepo(dir)

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
