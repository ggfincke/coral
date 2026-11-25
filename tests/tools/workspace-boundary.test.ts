// tests/tools/workspace-boundary.test.ts
// workspace symlink containment & byte-safe file tool behavior

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { revertFileChanges } from '../../src/agent/effects/file-replay.js'
import { editTool } from '../../src/tools/edit.js'
import { globTool } from '../../src/tools/glob.js'
import { grepTool } from '../../src/tools/grep.js'
import { listFilesTool } from '../../src/tools/list-files.js'
import { readTool } from '../../src/tools/read.js'
import type { ToolExecutionContext } from '../../src/tools/tool.js'
import { writeTool } from '../../src/tools/write.js'
import {
  overwriteRegularFile,
  readOptionalPreviousTextFile,
} from '../../src/utils/file-read.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()
const hasRipgrep = spawnSync('rg', ['--version']).status === 0

function toolContext(cwd: string): ToolExecutionContext
{
  return { cwd, ollamaHost: 'http://localhost:11434' }
}

test('write_file refuses dangling symlinks that would create files outside the workspace', async () =>
{
  const cwd = await tempDir('coral-dangling-ws-')
  const outside = await tempDir('coral-dangling-outside-')
  await symlink(join(outside, 'created.txt'), join(cwd, 'notes.txt'))
  await symlink(join(outside, 'missing-dir'), join(cwd, 'gone'))

  for (const path of ['notes.txt', 'gone/nested.txt'])
  {
    const result = await writeTool.execute(
      { path, content: 'x' },
      toolContext(cwd)
    )
    assert.match(result.error ?? '', /symlink|outside workspace/)
    assert.equal(result.change, undefined)
  }
  assert.equal(existsSync(join(outside, 'created.txt')), false)
  assert.equal(existsSync(join(outside, 'missing-dir')), false)

  // a link to an in-workspace file still writes through to its target
  await writeFile(join(cwd, 'target.txt'), 'old\n')
  await symlink(join(cwd, 'target.txt'), join(cwd, 'alias.txt'))
  const allowed = await writeTool.execute(
    { path: 'alias.txt', content: 'new\n' },
    toolContext(cwd)
  )
  assert.equal(allowed.error, undefined)
  assert.equal(await readFile(join(cwd, 'target.txt'), 'utf-8'), 'new\n')
})

// the state a racing process leaves after checkWorkspacePath passed: the
// reads & writes that follow must still refuse to leave the root
test('a link swapped in after the workspace check cannot redirect reads or writes', async () =>
{
  const cwd = await tempDir('coral-swap-ws-')
  const outside = await tempDir('coral-swap-outside-')
  const secret = join(outside, 'secret.txt')
  await writeFile(secret, 'outside-secret\n')
  await symlink(secret, join(cwd, 'new.txt'))

  const read = await readOptionalPreviousTextFile('new.txt', { cwd, root: cwd })
  assert.equal(read.ok, false)
  await assert.rejects(
    overwriteRegularFile(join(cwd, 'new.txt'), 'x', { root: cwd }),
    /outside/
  )
  assert.equal(await readFile(secret, 'utf-8'), 'outside-secret\n')
})

test('no-approval read tools never return content through escaping symlinks', async () =>
{
  const cwd = await tempDir('coral-readonly-ws-')
  const outside = await tempDir('coral-readonly-outside-')
  await writeFile(join(outside, 'secret.txt'), 'needle-secret\n')
  await symlink(outside, join(cwd, 'linkdir'), 'dir')
  await symlink(join(outside, 'secret.txt'), join(cwd, 'leak.txt'))

  const results = [
    await readTool.execute({ path: 'leak.txt' }, toolContext(cwd)),
    await readTool.execute({ path: 'linkdir/secret.txt' }, toolContext(cwd)),
    await listFilesTool.execute({ path: 'linkdir' }, toolContext(cwd)),
  ]
  if (hasRipgrep)
  {
    results.push(
      await grepTool.execute(
        { pattern: 'needle', path: 'linkdir' },
        toolContext(cwd)
      ),
      await globTool.execute(
        { pattern: '*', path: 'linkdir' },
        toolContext(cwd)
      )
    )
  }
  for (const result of results)
  {
    assert.match(result.error ?? '', /symlink/)
    assert.doesNotMatch(result.output, /needle-secret/)
  }

  if (hasRipgrep)
  {
    const rootGrep = await grepTool.execute(
      { pattern: 'needle' },
      toolContext(cwd)
    )
    assert.equal(rootGrep.output, 'No matches found.')
  }
})

test('edit_file & write_file refuse non-UTF-8 files and leave their bytes intact', async () =>
{
  const cwd = await tempDir('coral-latin1-')
  const original = Buffer.from([0x61, 0xe9, 0x0a, 0x62, 0x0a])
  const path = join(cwd, 'legacy.txt')
  await writeFile(path, original)

  const read = await readTool.execute({ path: 'legacy.txt' }, toolContext(cwd))
  assert.match(read.output, /not valid UTF-8/)

  const edit = await editTool.execute(
    { path: 'legacy.txt', old_string: 'b', new_string: 'c' },
    toolContext(cwd)
  )
  assert.match(edit.error ?? '', /not valid UTF-8/)
  const write = await writeTool.execute(
    { path: 'legacy.txt', content: 'replaced\n' },
    toolContext(cwd)
  )
  assert.match(write.error ?? '', /not valid UTF-8/)
  assert.deepEqual(await readFile(path), original)

  // a UTF-8 BOM is valid and survives an edit & its undo byte for byte
  const bomOriginal = Buffer.from('﻿key = 1\n', 'utf-8')
  const bomPath = join(cwd, 'bom.txt')
  await writeFile(bomPath, bomOriginal)
  const bomEdit = await editTool.execute(
    { path: 'bom.txt', old_string: '1', new_string: '2' },
    toolContext(cwd)
  )
  assert.equal(bomEdit.error, undefined)
  assert.deepEqual(await readFile(bomPath), Buffer.from('﻿key = 2\n', 'utf-8'))
  const undo = await revertFileChanges([bomEdit.change!], { cwd })
  assert.equal(undo.ok, true)
  assert.deepEqual(await readFile(bomPath), bomOriginal)
})

test(
  'read_file rejects a FIFO without blocking',
  { skip: spawnSync('mkfifo', ['--version']).error !== undefined },
  async () =>
  {
    const cwd = await tempDir('coral-fifo-')
    assert.equal(spawnSync('mkfifo', [join(cwd, 'pipe')]).status, 0)
    const result = await readTool.execute({ path: 'pipe' }, toolContext(cwd))
    assert.match(result.error ?? '', /not a regular file/)
  }
)

test('paths starting with ~ are rejected instead of creating a literal ~ dir', async () =>
{
  const cwd = await tempDir('coral-tilde-')
  const result = await writeTool.execute(
    { path: '~/coral-tilde.txt', content: 'x' },
    toolContext(cwd)
  )
  assert.match(result.error ?? '', /~/)
  assert.equal(existsSync(join(cwd, '~')), false)
})
