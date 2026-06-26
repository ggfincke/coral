// tests/diff.test.ts
// unit test for unified diff generation

import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setCwd } from '../src/cwd.js'
import {
  applyEdit,
  computeDiff,
  describeEditMiss,
  previewToolDiff,
} from '../src/utils/diff.js'
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
    matchType: 'exact',
  })

  // multiple matches w/ replaceAll -> every occurrence replaced, count reported
  assert.deepEqual(applyEdit('a.a.a', 'a', 'b', true), {
    ok: true,
    after: 'b.b.b',
    count: 3,
    matchType: 'exact',
  })

  // single match w/ replaceAll -> count stays 1
  assert.deepEqual(applyEdit('foo bar', 'bar', 'baz', true), {
    ok: true,
    after: 'foo baz',
    count: 1,
    matchType: 'exact',
  })
})

// the whitespace-tolerant fallback is what buys back weak-model edit failures;
// a regression here either silently misses real edits or hits the wrong block
test('applyEdit fuzzy-matches whitespace drift & re-indents the replacement', () =>
{
  // model over-indented (4 spaces) vs the file (2) — exact misses (the 4-space
  // string isn't present), fuzzy lands it, & the replacement is re-based to the
  // file's 2-space indent
  const file = 'function f()\n{\n  return x\n}\n'
  const drift = applyEdit(file, '    return x', '    return y', false)
  assert.deepEqual(drift, {
    ok: true,
    after: 'function f()\n{\n  return y\n}\n',
    count: 1,
    matchType: 'fuzzy',
  })

  // trailing-whitespace & CRLF drift on a multi-line block
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

  // ambiguous fuzzy match w/o replace_all -> refuse rather than guess. old_string
  // 'a1 ' has a trailing space so it never matches verbatim, forcing the fuzzy
  // path, where two normalized matches & no replace_all stays a miss
  const ambiguous = applyEdit('a1\n  a1\n', 'a1 ', 'b', false)
  assert.deepEqual(ambiguous, { ok: false, reason: 'not_found', count: 0 })

  // replace_all fuzzy -> every normalized match replaced
  const all = applyEdit('a1\n  a1\n', 'a1 ', 'b', true)
  assert.equal(all.ok, true)
  if (all.ok)
  {
    assert.equal(all.count, 2)
    assert.equal(all.matchType, 'fuzzy')
  }

  // a genuine miss still fails after the fuzzy pass
  assert.deepEqual(applyEdit('alpha\nbeta\n', 'gamma', 'delta', false), {
    ok: false,
    reason: 'not_found',
    count: 0,
  })
})

// the fuzzy path rebuilds the file by hand, so it must not corrupt structure:
// these guard the failure modes an adversarial review surfaced
test('applyEdit fuzzy path preserves file structure', () =>
{
  // empty new_string is a deletion — drop the block, no stray blank line
  const del = applyEdit('a\n  b\n  c\nd\n', '    b\n    c\n', '', false)
  assert.deepEqual(del, {
    ok: true,
    after: 'a\nd\n',
    count: 1,
    matchType: 'fuzzy',
  })

  // unchanged neighbor lines keep their real (deeper) indentation, not the
  // flat indent the model sent — only the genuinely new line is best-effort
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

  // CRLF survives across the whole matched block, including untouched lines
  const crlf = applyEdit('x\r\ny\r\nz\r\n', 'y', 'Y', false)
  assert.equal(crlf.ok, true)
  if (crlf.ok) assert.equal(crlf.after, 'x\r\nY\r\nz\r\n')

  // an all-whitespace old_string has no anchor — refuse rather than inject
  // content into a blank-line run
  assert.deepEqual(applyEdit('top\n\n\nbottom\n', '   \n   ', 'x = 1', false), {
    ok: false,
    reason: 'not_found',
    count: 0,
  })

  // self-overlapping multi-line block w/ replace_all stays non-overlapping, so
  // splices can't clobber each other
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
  // first line present but the block diverges -> name the line
  const partial = describeEditMiss(
    'let x = 1\nlet y = 2\n',
    'let x = 1\nlet z = 9'
  )
  assert.match(partial, /file line 1/)
  assert.match(partial, /later lines differ/)

  // nothing resembling old_string -> say so
  const absent = describeEditMiss('let x = 1\n', 'totally unrelated')
  assert.match(absent, /No file line matches/)

  // single-line old_string that fuzzy-matched a no-op -> honest message, not a
  // phantom "later lines differ"
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
