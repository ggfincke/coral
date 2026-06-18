// tests/diff.test.ts
// unit test for unified diff generation

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setCwd } from '../src/cwd.js'
import { applyEdit, computeDiff, previewToolDiff } from '../src/utils/diff.js'
import { TEXT_FILE_READ_LIMIT_BYTES } from '../src/utils/file-read.js'

const tempDirs: string[] = []
const originalCwd = process.cwd()

after(async () =>
{
  setCwd(originalCwd)
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

test('generates unified diffs for the major shapes', () =>
{
  // simple edit: hunk header + change w/ 3 lines of context
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\n'
  const edited = computeDiff(before, before.replace('d', 'D'))
  assert.ok(edited)
  assert.match(edited, /^@@ -1,7 \+1,7 @@/)
  assert.match(edited, /\n-d\n\+D\n/)
  // 3 context lines on each side of the change
  assert.match(edited, /\n a\n b\n c\n-d/)
  assert.match(edited, /\+D\n e\n f\n g$/)

  // new file: all additions
  const created = computeDiff('', 'hello\nworld\n')
  assert.ok(created)
  const signs = created
    .split('\n')
    .filter((line) => !line.startsWith('@@'))
    .map((line) => line[0])
  assert.ok(signs.every((sign) => sign === '+'))

  // nothing displayable -> null
  assert.equal(computeDiff('same\n', 'same\n'), null)
  assert.equal(computeDiff('a\0b', 'a\0c'), null)

  // oversized changes collapse into a summary marker
  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  const truncated = computeDiff('', big)
  assert.ok(truncated)
  assert.ok(truncated.split('\n').length < 250)
  assert.match(truncated, /… \+\d+ more changed lines$/)
})

// shared by editTool.execute & the approval preview — a regression here either
// corrupts a file or desyncs the preview from execution
test('applyEdit covers the substitution outcomes', () =>
{
  // empty old_string -> rejected before any scan
  assert.deepEqual(applyEdit('abc', '', 'x', false), {
    ok: false,
    reason: 'empty',
    count: 0,
  })

  // old === new -> rejected as identical
  assert.deepEqual(applyEdit('abc', 'a', 'a', false), {
    ok: false,
    reason: 'identical',
    count: 0,
  })

  // old_string absent -> not_found
  assert.deepEqual(applyEdit('abc', 'z', 'y', false), {
    ok: false,
    reason: 'not_found',
    count: 0,
  })

  // multiple matches w/o replaceAll -> rejected, count surfaced for the error
  assert.deepEqual(applyEdit('a.a.a', 'a', 'b', false), {
    ok: false,
    reason: 'multiple',
    count: 3,
  })

  // single match -> replaced once
  assert.deepEqual(applyEdit('foo bar', 'bar', 'baz', false), {
    ok: true,
    after: 'foo baz',
    count: 1,
  })

  // multiple matches w/ replaceAll -> every occurrence replaced, count reported
  assert.deepEqual(applyEdit('a.a.a', 'a', 'b', true), {
    ok: true,
    after: 'b.b.b',
    count: 3,
  })

  // single match w/ replaceAll -> count stays 1
  assert.deepEqual(applyEdit('foo bar', 'bar', 'baz', true), {
    ok: true,
    after: 'foo baz',
    count: 1,
  })
})

test('previewToolDiff reports oversized previous content without diffing', async () =>
{
  const dir = await tempDir('coral-preview-')
  const target = join(dir, 'big.txt')
  await writeFile(target, 'x'.repeat(TEXT_FILE_READ_LIMIT_BYTES + 1), 'utf-8')

  setCwd(dir)
  const preview = await previewToolDiff('write_file', {
    path: 'big.txt',
    content: 'replacement\n',
  })

  assert.equal(preview?.kind, 'message')
  if (preview?.kind === 'message')
  {
    assert.match(preview.message, /Preview skipped:/)
    assert.match(preview.message, /exceeds 1\.0MB read limit/)
  }
})
