// tests/tools.test.ts
// tests for high-risk tool behavior

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setCwd } from '../src/cwd.js'
import { bashTool } from '../src/tools/bash.js'
import { globTool } from '../src/tools/glob.js'
import { grepTool } from '../src/tools/grep.js'
import { listFilesTool } from '../src/tools/list-files.js'
import { writeTool } from '../src/tools/write.js'
import {
  gitDiffTool,
  gitLogTool,
  gitAddTool,
  gitCommitTool,
  gitSwitchTool,
  gitPushTool,
} from '../src/tools/git.js'
import { taskTool } from '../src/tools/task.js'
import { setSubagentRunner } from '../src/tools/subagent.js'
import { subagentTools } from '../src/tools/index.js'
import { searchCodeTool } from '../src/tools/search-code.js'
import { TEXT_FILE_READ_LIMIT_BYTES } from '../src/utils/file-read.js'
import { execFileCommand, formatProcessError } from '../src/utils/process.js'

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
    './',
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
    assert.deepEqual(result.output.split('\n'), ['new.txt', 'old.txt'])
  }
)

test(
  'grep returns project-relative match paths',
  { skip: !hasRipgrep },
  async () =>
  {
    const dir = await tempDir('coral-grep-')
    await mkdir(join(dir, 'src'))
    await writeFile(
      join(dir, 'src', 'session.ts'),
      'export function restoreSession() {}\n',
      'utf-8'
    )

    setCwd(dir)
    const result = await grepTool.execute({ pattern: 'restoreSession' })

    assert.equal(result.error, undefined)
    assert.deepEqual(result.output.split('\n'), [
      'src/session.ts:1:export function restoreSession() {}',
    ])
  }
)

test('write_file overwrites oversized targets without previewing old content', async () =>
{
  const dir = await tempDir('coral-write-big-')
  const target = join(dir, 'big.txt')
  await writeFile(target, 'x'.repeat(TEXT_FILE_READ_LIMIT_BYTES + 1), 'utf-8')

  setCwd(dir)
  const result = await writeTool.execute({
    path: 'big.txt',
    content: 'small\n',
  })

  assert.equal(result.error, undefined)
  assert.equal(result.diff, undefined)
  assert.match(result.output, /Wrote 6 bytes/)
  assert.match(result.output, /Diff skipped:/)
  assert.match(result.output, /exceeds 1\.0MB read limit/)
  assert.equal(await readFile(target, 'utf-8'), 'small\n')
})

test('process helper captures stdout, stderr, ENOENT, and timeouts', async () =>
{
  const success = await execFileCommand(process.execPath, [
    '-e',
    'process.stdout.write("out"); process.stderr.write("err")',
  ])
  assert.deepEqual(success, { ok: true, stdout: 'out', stderr: 'err' })

  const failure = await execFileCommand(process.execPath, [
    '-e',
    'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)',
  ])
  assert.equal(failure.ok, false)
  if (!failure.ok)
  {
    assert.equal(failure.stdout, 'out')
    assert.equal(failure.stderr, 'err')
    assert.equal(failure.code, 3)
    assert.equal(formatProcessError(failure), 'err')
    assert.equal(
      formatProcessError(failure, { includeStdout: true }),
      'out\nerr'
    )
  }

  const missing = await execFileCommand('__coral_missing_command__', [])
  assert.equal(missing.ok, false)
  if (!missing.ok)
  {
    assert.equal(missing.code, 'ENOENT')
  }

  const timeout = await execFileCommand(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 1000)'],
    { timeout: 10 }
  )
  assert.equal(timeout.ok, false)
  if (!timeout.ok)
  {
    assert.ok(timeout.message || timeout.signal || timeout.code)
  }
})

test('bash preserves stdout separately from stderr failures', async () =>
{
  const dir = await tempDir('coral-bash-')
  const script =
    'process.stdout.write("out"); process.stderr.write("err"); process.exit(4)'
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`

  setCwd(dir)
  const result = await bashTool.execute({ command })

  assert.equal(result.output, 'out')
  assert.equal(result.error, 'err')
})

test('bash kills the spawned child when the run is aborted', async () =>
{
  const dir = await tempDir('coral-bash-abort-')
  setCwd(dir)

  // a child that would outlive any reasonable test wait
  const script = 'setTimeout(() => {}, 30000)'
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`

  const controller = new AbortController()
  const startedAt = Date.now()
  setTimeout(() => controller.abort(), 50)

  const result = await bashTool.execute(
    { command },
    {
      cwd: dir,
      ollamaHost: 'http://localhost:11434',
      signal: controller.signal,
    }
  )

  // resolves on abort, not after the 30s child — proves the child was signaled
  assert.ok(Date.now() - startedAt < 5000)
  assert.ok(result.error)
})

test('git tools reject option-like inputs before shelling out', async () =>
{
  const dir = await tempDir('coral-gitsec-')
  setCwd(dir)
  const target = join(dir, 'PWNED')

  const diff = await gitDiffTool.execute({ ref: `--output=${target}` })
  const log = await gitLogTool.execute({ ref: `--output=${target}` })
  const add = await gitAddTool.execute({ paths: ['note.txt', '--all'] })
  const branch = await gitSwitchTool.execute({ branch: '--orphan=evil' })
  const push = await gitPushTool.execute({ remote: '--exec=evil' })

  assert.match(diff.error ?? '', /Invalid ref/)
  assert.match(log.error ?? '', /Invalid ref/)
  assert.match(add.error ?? '', /Invalid path/)
  assert.match(branch.error ?? '', /Invalid branch/)
  assert.match(push.error ?? '', /Invalid remote/)
  assert.equal(existsSync(target), false)
})

test(
  'git_switch creates a branch and reports remaining status',
  { skip: !hasGit },
  async () =>
  {
    const dir = await tempDir('coral-gitswitch-')
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
    await writeFile(join(dir, 'a.txt'), 'hello\n', 'utf-8')
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: dir }).status, 0)
    assert.equal(
      spawnSync('git', ['commit', '-m', 'init'], { cwd: dir }).status,
      0
    )
    await writeFile(join(dir, 'dirty.txt'), 'dirty\n', 'utf-8')

    setCwd(dir)
    assert.equal(
      gitSwitchTool.display?.summarize?.({
        branch: 'feat/git-context',
        create: true,
        startPoint: 'main',
      }),
      '-c feat/git-context main'
    )
    const result = await gitSwitchTool.execute({
      branch: 'feat/git-context',
      create: true,
    })
    const current = spawnSync('git', ['branch', '--show-current'], {
      cwd: dir,
      encoding: 'utf-8',
    })

    assert.equal(result.error, undefined)
    assert.equal(current.stdout.trim(), 'feat/git-context')
    assert.match(result.output, /Current branch: feat\/git-context/)
    assert.match(result.output, /\?\? dirty\.txt/)
  }
)

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
  'git_commit reports a clean-tree failure without changing HEAD',
  { skip: !hasGit },
  async () =>
  {
    const dir = await tempDir('coral-gitcommit-clean-')
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
    await writeFile(join(dir, 'a.txt'), 'hello\n', 'utf-8')
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: dir }).status, 0)
    assert.equal(
      spawnSync('git', ['commit', '-m', 'init'], { cwd: dir }).status,
      0
    )

    const before = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8',
    })
    assert.equal(before.status, 0)

    setCwd(dir)
    const result = await gitCommitTool.execute({ message: 'noop' })

    const after = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8',
    })
    assert.equal(after.status, 0)
    assert.equal(result.output, '')
    assert.match(result.error ?? '', /nothing to commit|working tree clean/i)
    assert.equal(after.stdout.trim(), before.stdout.trim())
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

test('subagentTools exposes only subagent-safe tools', () =>
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
    'git_switch',
    'git_push',
    'task',
    'todo_write',
  ])
  {
    assert.ok(!names.includes(name), `subagent must not expose ${name}`)
  }
  assert.ok(subagentTools.every((tool) => tool.subagentSafe === true))
  assert.equal(searchCodeTool.subagentSafe, true)
  assert.equal(searchCodeTool.parallelSafe, undefined)
})
