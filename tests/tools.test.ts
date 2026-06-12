// tests/tools.test.ts
// tests for high-risk tool behavior

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
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
import { taskTool } from '../src/tools/task.js'
import { setSubagentRunner } from '../src/tools/subagent.js'
import { subagentTools } from '../src/tools/index.js'

const tempDirs: string[] = []
const originalCwd = process.cwd()
const hasRipgrep = spawnSync('rg', ['--version']).status === 0
const hasGit = spawnSync('git', ['--version']).status === 0

after(async () =>
{
  setCwd(originalCwd)
  setSubagentRunner(null)
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

async function tempDir(prefix: string): Promise<string>
{
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

test('list_files renders nested project entries under the correct parent', async () =>
{
  const dir = await tempDir('coral-tree-')
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
  'glob returns newest matching files first',
  { skip: !hasRipgrep },
  async () =>
  {
    const dir = await tempDir('coral-glob-')
    const oldPath = join(dir, 'old.txt')
    const newPath = join(dir, 'new.txt')
    await writeFile(oldPath, 'old\n', 'utf-8')
    await writeFile(newPath, 'new\n', 'utf-8')
    await utimes(
      oldPath,
      new Date('2024-01-01T01:01:00.000Z'),
      new Date('2024-01-01T01:01:00.000Z')
    )
    await utimes(
      newPath,
      new Date('2025-01-01T01:01:00.000Z'),
      new Date('2025-01-01T01:01:00.000Z')
    )

    setCwd(dir)
    const result = await globTool.execute({ pattern: '*.txt' })

    assert.equal(result.error, undefined)
    assert.deepEqual(result.output.split('\n'), [newPath, oldPath])
  }
)

test('git tools reject option-like inputs before shelling out', async () =>
{
  const dir = await tempDir('coral-gitsec-')
  setCwd(dir)
  const target = join(dir, 'PWNED')

  const diff = await gitDiffTool.execute({ ref: `--output=${target}` })
  const log = await gitLogTool.execute({ ref: `--output=${target}` })
  const add = await gitAddTool.execute({ paths: ['note.txt', '--all'] })
  const push = await gitPushTool.execute({ remote: '--exec=evil' })

  assert.match(diff.error ?? '', /Invalid ref/)
  assert.match(log.error ?? '', /Invalid ref/)
  assert.match(add.error ?? '', /Invalid path/)
  assert.match(push.error ?? '', /Invalid remote/)
  assert.equal(existsSync(target), false)
})

test(
  'git_add and git_commit create a real commit',
  { skip: !hasGit },
  async () =>
  {
    const dir = await tempDir('coral-gitcommit-')
    spawnSync('git', ['init'], { cwd: dir })
    spawnSync('git', ['config', 'user.email', 'test@coral.dev'], { cwd: dir })
    spawnSync('git', ['config', 'user.name', 'Coral Test'], { cwd: dir })
    await writeFile(join(dir, 'a.txt'), 'hello\n', 'utf-8')

    setCwd(dir)
    const add = await gitAddTool.execute({ all: true })
    const commit = await gitCommitTool.execute({ message: 'init commit' })

    assert.equal(add.error, undefined)
    assert.equal(commit.error, undefined)
    assert.match(commit.output, /init commit/)
  }
)

test(
  'git_push can publish a commit to a local remote',
  { skip: !hasGit },
  async () =>
  {
    const bare = await tempDir('coral-bare-')
    spawnSync('git', ['init', '--bare', bare])

    const work = await tempDir('coral-push-')
    spawnSync('git', ['init', work])
    spawnSync('git', ['-C', work, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    spawnSync('git', ['-C', work, 'config', 'user.email', 'test@coral.dev'])
    spawnSync('git', ['-C', work, 'config', 'user.name', 'Coral Test'])
    await writeFile(join(work, 'a.txt'), 'hello\n', 'utf-8')
    spawnSync('git', ['-C', work, 'add', '-A'])
    spawnSync('git', ['-C', work, 'commit', '-m', 'init'])
    spawnSync('git', ['-C', work, 'remote', 'add', 'origin', bare])

    setCwd(work)
    const result = await gitPushTool.execute({
      remote: 'origin',
      branch: 'main',
      setUpstream: true,
    })
    const log = spawnSync('git', ['-C', bare, 'log', '--oneline', 'main'], {
      encoding: 'utf-8',
    })

    assert.equal(result.error, undefined)
    assert.match(log.stdout, /init/)
  }
)

test('task tool fails closed when subagents are unavailable', async () =>
{
  setSubagentRunner(null)

  const noPrompt = await taskTool.execute({})
  const noRunner = await taskTool.execute({ prompt: 'explore the repo' })

  assert.match(noPrompt.error ?? '', /non-empty prompt/)
  assert.match(noRunner.error ?? '', /unavailable/i)
})

test('subagentTools exposes only read-only tools', () =>
{
  const names = subagentTools.map((tool) => tool.name)

  assert.ok(names.includes('read_file'))
  assert.ok(names.includes('grep'))
  assert.ok(names.includes('search_code'))
  for (const name of [
    'write_file',
    'edit_file',
    'bash',
    'git_add',
    'git_commit',
    'git_push',
    'task',
    'todo_write',
  ])
  {
    assert.ok(!names.includes(name), `subagent must not expose ${name}`)
  }
  assert.ok(subagentTools.every((tool) => tool.readOnly === true))
})
