// tests/agent/effects/file-replay.test.ts
// file snapshot revert/apply behavior for undo & redo

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { chmod, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  applyFileChanges,
  revertFileChanges,
} from '../../../src/agent/effects/file-replay.js'
import type { UndoFileChange } from '../../../src/types/undo.js'
import { makeTempDirPool } from '../../helpers/temp.js'

const { tempDir } = makeTempDirPool()

test('revertFileChanges restores edited files and removes created files', async () =>
{
  const dir = await tempDir('coral-undo-')
  const edited = join(dir, 'edited.txt')
  const created = join(dir, 'created.txt')
  await writeFile(edited, 'after\n', 'utf-8')
  await writeFile(created, 'new\n', 'utf-8')

  const changes: UndoFileChange[] = [
    { path: edited, before: 'before\n', after: 'after\n' },
    { path: created, before: null, after: 'new\n' },
  ]

  const result = await revertFileChanges(changes, { cwd: dir })

  assert.deepEqual(result, { ok: true, changedFiles: 2 })
  assert.equal(await readFile(edited, 'utf-8'), 'before\n')
  assert.equal(existsSync(created), false)
})

test('redo applies captured after-content from an undone state', async () =>
{
  const dir = await tempDir('coral-redo-')
  const edited = join(dir, 'edited.txt')
  const created = join(dir, 'created.txt')
  await writeFile(edited, 'before\n', 'utf-8')

  const changes: UndoFileChange[] = [
    { path: edited, before: 'before\n', after: 'after\n' },
    { path: created, before: null, after: 'new\n' },
  ]

  const result = await applyFileChanges(changes, { cwd: dir })

  assert.deepEqual(result, { ok: true, changedFiles: 2 })
  assert.equal(await readFile(edited, 'utf-8'), 'after\n')
  assert.equal(await readFile(created, 'utf-8'), 'new\n')
})

test('same-file changes collapse to the net before and after snapshots', async () =>
{
  const dir = await tempDir('coral-undo-net-')
  const target = join(dir, 'file.txt')
  await writeFile(target, 'three\n', 'utf-8')

  const changes: UndoFileChange[] = [
    { path: target, before: 'one\n', after: 'two\n' },
    { path: target, before: 'two\n', after: 'three\n' },
  ]

  const result = await revertFileChanges(changes, { cwd: dir })

  assert.deepEqual(result, { ok: true, changedFiles: 1 })
  assert.equal(await readFile(target, 'utf-8'), 'one\n')
})

test('revertFileChanges refuses to clobber externally changed files', async () =>
{
  const dir = await tempDir('coral-undo-mismatch-')
  const target = join(dir, 'file.txt')
  await writeFile(target, 'external\n', 'utf-8')

  const result = await revertFileChanges(
    [{ path: target, before: 'before\n', after: 'after\n' }],
    { cwd: dir }
  )

  assert.equal(result.ok, false)
  if (!result.ok)
  {
    assert.match(result.error, /changed outside Coral/)
  }
  assert.equal(await readFile(target, 'utf-8'), 'external\n')
})

test('revertFileChanges rolls back earlier files when a later write fails', async () =>
{
  const dir = await tempDir('coral-undo-rollback-')
  const first = join(dir, 'first.txt')
  const second = join(dir, 'second.txt')
  await writeFile(first, 'after one\n', 'utf-8')
  await writeFile(second, 'after two\n', 'utf-8')
  await chmod(second, 0o444)

  const result = await revertFileChanges(
    [
      { path: first, before: 'before one\n', after: 'after one\n' },
      { path: second, before: 'before two\n', after: 'after two\n' },
    ],
    { cwd: dir }
  )

  assert.equal(result.ok, false)
  assert.equal(await readFile(first, 'utf-8'), 'after one\n')
  assert.equal(await readFile(second, 'utf-8'), 'after two\n')
  await chmod(second, 0o644)
})

test('undo replay refuses paths outside the workspace', async () =>
{
  const dir = await tempDir('coral-undo-workspace-')
  const outsideDir = await tempDir('coral-undo-outside-')
  const outside = join(outsideDir, 'file.txt')
  await writeFile(outside, 'after\n', 'utf-8')

  const result = await revertFileChanges(
    [{ path: outside, before: 'before\n', after: 'after\n' }],
    { cwd: dir }
  )

  assert.equal(result.ok, false)
  if (!result.ok)
  {
    assert.match(result.error, /outside workspace/)
  }
  assert.equal(await readFile(outside, 'utf-8'), 'after\n')
})

test('undo replay refuses symlinks that resolve outside the workspace', async () =>
{
  const dir = await tempDir('coral-undo-symlink-')
  const outsideDir = await tempDir('coral-undo-symlink-target-')
  const outside = join(outsideDir, 'file.txt')
  const link = join(dir, 'link.txt')
  await writeFile(outside, 'after\n', 'utf-8')
  await symlink(outside, link)

  const result = await revertFileChanges(
    [{ path: link, before: 'before\n', after: 'after\n' }],
    { cwd: dir }
  )

  assert.equal(result.ok, false)
  if (!result.ok)
  {
    assert.match(result.error, /symlink/)
  }
  assert.equal(await readFile(outside, 'utf-8'), 'after\n')
})
