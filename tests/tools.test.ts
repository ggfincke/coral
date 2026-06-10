// tests/tools.test.ts
// regression tests for file-discovery tools

import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setCwd } from '../src/cwd.js'
import { globTool } from '../src/tools/glob.js'
import { listFilesTool } from '../src/tools/list-files.js'
import {
  gitDiffTool,
  gitLogTool,
  gitAddTool,
  gitCommitTool,
  gitPushTool,
} from '../src/tools/git.js'

const tempDirs: string[] = []
const originalCwd = process.cwd()
const hasRipgrep = spawnSync('rg', ['--version']).status === 0
const hasGit = spawnSync('git', ['--version']).status === 0

// restore temp dirs & cwd after tests finish
after(async () =>
{
  setCwd(originalCwd)
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

test('list_files renders nested entries under the correct parent', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-tree-'))
  tempDirs.push(dir)

  await mkdir(join(dir, 'nested'))
  await mkdir(join(dir, 'other'))
  await writeFile(join(dir, 'alpha.txt'), 'alpha\n', 'utf-8')
  await writeFile(join(dir, 'nested', 'child.txt'), 'child\n', 'utf-8')
  await writeFile(join(dir, 'other', 'deep.txt'), 'deep\n', 'utf-8')

  setCwd(dir)
  const result = await listFilesTool.execute({ path: '.', depth: 2 })

  assert.equal(result.error, undefined)
  assert.deepEqual(result.output.split('\n'), [
    `${dir}/`,
    '  alpha.txt',
    '  nested/',
    '    child.txt',
    '  other/',
    '    deep.txt',
  ])
})

test(
  'glob returns the newest modified file first',
  { skip: !hasRipgrep },
  async () =>
  {
    const dir = await mkdtemp(join(tmpdir(), 'coral-glob-'))
    tempDirs.push(dir)

    const oldPath = join(dir, 'old.txt')
    const newPath = join(dir, 'new.txt')

    await writeFile(oldPath, 'old\n', 'utf-8')
    await writeFile(newPath, 'new\n', 'utf-8')

    const oldTime = new Date('2024-01-01T01:01:00.000Z')
    const newTime = new Date('2025-01-01T01:01:00.000Z')

    await utimes(oldPath, oldTime, oldTime)
    await utimes(newPath, newTime, newTime)

    setCwd(dir)
    const result = await globTool.execute({ pattern: '*.txt' })

    assert.equal(result.error, undefined)
    assert.deepEqual(result.output.split('\n'), [newPath, oldPath])
  }
)

// the guard rejects before git runs, so no repo is needed
test('git_diff rejects option-like refs without writing files', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-gitsec-'))
  tempDirs.push(dir)
  setCwd(dir)

  const target = join(dir, 'PWNED')
  const result = await gitDiffTool.execute({ ref: `--output=${target}` })

  assert.match(result.error ?? '', /Invalid ref/)
  assert.equal(existsSync(target), false)
})

test('git_log rejects option-like refs without writing files', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-gitsec-'))
  tempDirs.push(dir)
  setCwd(dir)

  const target = join(dir, 'PWNED')
  const result = await gitLogTool.execute({ ref: `--output=${target}` })

  assert.match(result.error ?? '', /Invalid ref/)
  assert.equal(existsSync(target), false)
})

// the guard rejects before git runs, so no repo is needed
test('git_add rejects option-like paths', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-gitsec-'))
  tempDirs.push(dir)
  setCwd(dir)

  const result = await gitAddTool.execute({ paths: ['note.txt', '--all'] })
  assert.match(result.error ?? '', /Invalid path/)
})

test('git_commit rejects an empty message', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-gitsec-'))
  tempDirs.push(dir)
  setCwd(dir)

  const result = await gitCommitTool.execute({ message: '   ' })
  assert.match(result.error ?? '', /non-empty message/)
})

test(
  'git_add & git_commit create a commit',
  { skip: !hasGit },
  async () =>
  {
    const dir = await mkdtemp(join(tmpdir(), 'coral-gitcommit-'))
    tempDirs.push(dir)
    spawnSync('git', ['init'], { cwd: dir })
    spawnSync('git', ['config', 'user.email', 'test@coral.dev'], { cwd: dir })
    spawnSync('git', ['config', 'user.name', 'Coral Test'], { cwd: dir })
    await writeFile(join(dir, 'a.txt'), 'hello\n', 'utf-8')

    setCwd(dir)
    const add = await gitAddTool.execute({ all: true })
    assert.equal(add.error, undefined)

    const commit = await gitCommitTool.execute({ message: 'init commit' })
    assert.equal(commit.error, undefined)
    assert.match(commit.output, /init commit/)
  }
)

// the guards reject before git runs, so no repo is needed
test('git_push rejects option-like remotes & branch without remote', async () =>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-gitsec-'))
  tempDirs.push(dir)
  setCwd(dir)

  const badRemote = await gitPushTool.execute({ remote: '--exec=evil' })
  assert.match(badRemote.error ?? '', /Invalid remote/)

  const noRemote = await gitPushTool.execute({ branch: 'main' })
  assert.match(noRemote.error ?? '', /requires a remote/)

  const noTarget = await gitPushTool.execute({ setUpstream: true })
  assert.match(noTarget.error ?? '', /setUpstream requires/)
})

test('git_push pushes commits to a local remote', { skip: !hasGit }, async () =>
{
  const bare = await mkdtemp(join(tmpdir(), 'coral-bare-'))
  tempDirs.push(bare)
  spawnSync('git', ['init', '--bare', bare])

  const work = await mkdtemp(join(tmpdir(), 'coral-push-'))
  tempDirs.push(work)
  spawnSync('git', ['init', work])
  // force the branch name to main regardless of git version/config defaults
  spawnSync('git', ['-C', work, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  spawnSync('git', ['-C', work, 'config', 'user.email', 'test@coral.dev'])
  spawnSync('git', ['-C', work, 'config', 'user.name', 'Coral Test'])
  await writeFile(join(work, 'a.txt'), 'hello\n', 'utf-8')
  spawnSync('git', ['-C', work, 'add', '-A'])
  spawnSync('git', ['-C', work, 'commit', '-m', 'init'])
  spawnSync('git', ['-C', work, 'remote', 'add', 'origin', bare])

  setCwd(work)
  const res = await gitPushTool.execute({
    remote: 'origin',
    branch: 'main',
    setUpstream: true,
  })
  assert.equal(res.error, undefined)

  // the bare remote now holds the pushed commit — query the pushed branch
  // directly, since the bare HEAD may default to a different branch name
  const log = spawnSync('git', ['-C', bare, 'log', '--oneline', 'main'], {
    encoding: 'utf-8',
  })
  assert.match(log.stdout, /init/)
})
