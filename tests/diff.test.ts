// tests/diff.test.ts
// tests for edit transformations, diffs, & approval previews

import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setCwd } from '../src/cwd.js'
import { applyEdit, describeEditMiss } from '../src/tools/edit-operation.js'
import { previewToolDiff } from '../src/tools/preview.js'
import { computeDiff } from '../src/utils/diff.js'
import { TEXT_FILE_READ_LIMIT_BYTES } from '../src/utils/file-read.js'
import { makeTempDirPool } from './helpers/temp.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const originalCwd = process.cwd()

after(async () =>
{
  setCwd(originalCwd)
  await cleanup()
})

test('generates unified diffs for the major shapes', () =>
{
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\n'
  const edited = computeDiff(before, before.replace('d', 'D'))
  assert.ok(edited)
  assert.match(edited, /^@@ -1,7 \+1,7 @@/)
  assert.match(edited, /\n-d\n\+D\n/)
  assert.match(edited, /\n a\n b\n c\n-d/)
  assert.match(edited, /\+D\n e\n f\n g$/)

  const created = computeDiff('', 'hello\nworld\n')
  assert.ok(created)
  const signs = created
    .split('\n')
    .filter((line) => !line.startsWith('@@'))
    .map((line) => line[0])
  assert.ok(signs.every((sign) => sign === '+'))

  assert.equal(computeDiff('same\n', 'same\n'), null)
  assert.equal(computeDiff('a\0b', 'a\0c'), null)

  // keep oversized previews bounded while retaining their summary marker
  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  const truncated = computeDiff('', big)
  assert.ok(truncated)
  assert.ok(truncated.split('\n').length < 250)
  assert.match(truncated, /… \+\d+ more changed lines$/)
})

// keep editTool.execute & the approval preview on the same transformation path
test('applyEdit covers the substitution outcomes', () =>
{
  assert.deepEqual(applyEdit('abc', '', 'x', false), {
    ok: false,
    reason: 'empty',
    count: 0,
  })

  assert.deepEqual(applyEdit('abc', 'a', 'a', false), {
    ok: false,
    reason: 'identical',
    count: 0,
  })

  assert.deepEqual(applyEdit('abc', 'z', 'y', false), {
    ok: false,
    reason: 'not_found',
    count: 0,
  })

  assert.deepEqual(applyEdit('a.a.a', 'a', 'b', false), {
    ok: false,
    reason: 'multiple',
    count: 3,
  })

  assert.deepEqual(applyEdit('foo bar', 'bar', 'baz', false), {
    ok: true,
    after: 'foo baz',
    count: 1,
    matchType: 'exact',
  })

  assert.deepEqual(applyEdit('a.a.a', 'a', 'b', true), {
    ok: true,
    after: 'b.b.b',
    count: 3,
    matchType: 'exact',
  })

  assert.deepEqual(applyEdit('foo bar', 'bar', 'baz', true), {
    ok: true,
    after: 'foo baz',
    count: 1,
    matchType: 'exact',
  })
})

// exercise the whitespace fallback used when weak-model edits drift
test('applyEdit fuzzy-matches whitespace drift & re-indents the replacement', () =>
{
  // rebase a fuzzy replacement to the file's indentation
  const file = 'function f()\n{\n  return x\n}\n'
  const drift = applyEdit(file, '    return x', '    return y', false)
  assert.deepEqual(drift, {
    ok: true,
    after: 'function f()\n{\n  return y\n}\n',
    count: 1,
    matchType: 'fuzzy',
  })

  const crlf = 'const a = 1\r\nconst b = 2\r\n'
  const trailing = applyEdit(
    crlf,
    'const a = 1  \nconst b = 2',
    'const a = 9',
    false
  )
  assert.equal(trailing.ok, true)
  if (trailing.ok)
  {
    assert.equal(trailing.matchType, 'fuzzy')
    assert.match(trailing.after, /const a = 9/)
  }

  // refuse an ambiguous fuzzy match rather than guessing
  const ambiguous = applyEdit('a1\n  a1\n', 'a1 ', 'b', false)
  assert.deepEqual(ambiguous, { ok: false, reason: 'not_found', count: 0 })

  const all = applyEdit('a1\n  a1\n', 'a1 ', 'b', true)
  assert.equal(all.ok, true)
  if (all.ok)
  {
    assert.equal(all.count, 2)
    assert.equal(all.matchType, 'fuzzy')
  }

  assert.deepEqual(applyEdit('alpha\nbeta\n', 'gamma', 'delta', false), {
    ok: false,
    reason: 'not_found',
    count: 0,
  })
})

// preserve file structure while rebuilding fuzzy matches
test('applyEdit fuzzy path preserves file structure', () =>
{
  const del = applyEdit('a\n  b\n  c\nd\n', '    b\n    c\n', '', false)
  assert.deepEqual(del, {
    ok: true,
    after: 'a\nd\n',
    count: 1,
    matchType: 'fuzzy',
  })

  const nested = applyEdit(
    '  a()\n    b()\n',
    'a()\nb()',
    'a()\nb()\nc()',
    false
  )
  assert.deepEqual(nested, {
    ok: true,
    after: '  a()\n    b()\n  c()\n',
    count: 1,
    matchType: 'fuzzy',
  })

  const crlf = applyEdit('x\r\ny\r\nz\r\n', 'y', 'Y', false)
  assert.equal(crlf.ok, true)
  if (crlf.ok) assert.equal(crlf.after, 'x\r\nY\r\nz\r\n')

  // refuse whitespace-only matches that have no structural anchor
  assert.deepEqual(applyEdit('top\n\n\nbottom\n', '   \n   ', 'x = 1', false), {
    ok: false,
    reason: 'not_found',
    count: 0,
  })

  // keep overlapping replace_all matches non-overlapping
  const overlap = applyEdit('a \na \na \n', 'a\na', 'X\nY', true)
  assert.deepEqual(overlap, {
    ok: true,
    after: 'X\nY\na \n',
    count: 1,
    matchType: 'fuzzy',
  })
})

test('describeEditMiss points at a partial match or its absence', () =>
{
  const partial = describeEditMiss(
    'let x = 1\nlet y = 2\n',
    'let x = 1\nlet z = 9'
  )
  assert.match(partial, /file line 1/)
  assert.match(partial, /later lines differ/)

  const absent = describeEditMiss('let x = 1\n', 'totally unrelated')
  assert.match(absent, /No file line matches/)

  const single = describeEditMiss('  let x = 1\n', '\tlet x = 1')
  assert.match(single, /changes nothing/)
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
    assert.match(preview.message, /exceeds 1\.0 MB read limit/)
  }
})

test('previewToolDiff uses request cwd and does not leak off-workspace content', async () =>
{
  const globalDir = await tempDir('coral-preview-global-')
  const agentDir = await tempDir('coral-preview-agent-')
  const outside = await tempDir('coral-preview-outside-')
  await writeFile(join(globalDir, 'same.txt'), 'global secret\n', 'utf-8')
  await writeFile(join(agentDir, 'same.txt'), 'agent visible\n', 'utf-8')
  await writeFile(join(outside, 'secret.txt'), 'SECRET_VALUE\n', 'utf-8')

  setCwd(globalDir)

  const scoped = await previewToolDiff(
    'write_file',
    {
      path: 'same.txt',
      content: 'replacement\n',
    },
    { cwd: agentDir }
  )
  const outsideWrite = await previewToolDiff(
    'write_file',
    {
      path: join(outside, 'secret.txt'),
      content: 'replacement\n',
    },
    { cwd: agentDir }
  )
  const outsideEdit = await previewToolDiff(
    'edit_file',
    {
      path: join(outside, 'secret.txt'),
      old_string: 'SECRET_VALUE',
      new_string: 'replacement',
    },
    { cwd: agentDir }
  )

  assert.equal(scoped?.kind, 'diff')
  if (scoped?.kind === 'diff')
  {
    assert.ok(scoped.diff.includes('-agent visible'))
    assert.ok(!scoped.diff.includes('global secret'))
  }
  assert.equal(outsideWrite?.kind, 'message')
  assert.equal(outsideEdit?.kind, 'message')
  assert.ok(!JSON.stringify(outsideWrite).includes('SECRET_VALUE'))
  assert.ok(!JSON.stringify(outsideEdit).includes('SECRET_VALUE'))
})
