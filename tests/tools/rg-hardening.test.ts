// tests/tools/rg-hardening.test.ts
// grep & glob keep model paths out of rg flags and skip .git internals

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { globTool } from '../../src/tools/glob.js'
import { grepTool } from '../../src/tools/grep.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { HAS_GIT, initTestRepo } from '../helpers/git.js'

const { tempDir } = makeTempDirPool()
const hasRipgrep = spawnSync('rg', ['--version']).status === 0

function toolContext(cwd: string)
{
  return { cwd, ollamaHost: 'http://unused' }
}

test(
  'a dash-led search path is a path, never an rg flag',
  { skip: !hasRipgrep },
  async () =>
  {
    const dir = await tempDir('coral-rg-flag-')
    const marker = join(dir, 'MARKER')
    await writeFile(join(dir, 'run.sh'), `#!/bin/sh\ntouch "${marker}"\n`)
    await chmod(join(dir, 'run.sh'), 0o755)
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'a.txt'), 'hello\n')
    await mkdir(join(dir, '--follow'))
    await writeFile(join(dir, '--follow', 'b.txt'), 'hello\n')

    const injected = await grepTool.execute(
      { pattern: 'hello', path: '--pre=./run.sh' },
      toolContext(dir)
    )
    const dashDir = await globTool.execute(
      { pattern: '*.txt', path: '--follow' },
      toolContext(dir)
    )
    const plain = await grepTool.execute(
      { pattern: 'hello', path: 'src' },
      toolContext(dir)
    )

    assert.ok(injected.error)
    assert.equal(existsSync(marker), false)
    assert.equal(dashDir.output.trim(), './--follow/b.txt')
    assert.equal(plain.output.trim(), 'src/a.txt:1:hello')
  }
)

test(
  'grep and glob leave .git internals out of results',
  { skip: !hasRipgrep || !HAS_GIT },
  async () =>
  {
    const dir = await tempDir('coral-rg-git-')
    const run = initTestRepo(dir)
    await writeFile(join(dir, 'app.ts'), 'export const needle = 1\n')
    assert.equal(run('add', '-A').status, 0)
    assert.equal(run('commit', '-m', 'needle commit').status, 0)

    const files = await globTool.execute({ pattern: '**/*' }, toolContext(dir))
    const matches = await grepTool.execute(
      { pattern: 'needle' },
      toolContext(dir)
    )

    assert.equal(files.output.trim(), 'app.ts')
    assert.equal(matches.output.trim(), 'app.ts:1:export const needle = 1')
  }
)
