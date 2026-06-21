// tests/completion.test.ts
// tests for prompt completion logic & @-mention expansion

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  applyCompletion,
  detectCompletion,
  rankCommands,
  rankFiles,
  type CommandSummary,
} from '../src/tui/completion.js'
import {
  buildMentionContext,
  formatMentionNotice,
  parseMentions,
} from '../src/tui/mentions.js'
import { isLikelyTextPath } from '../src/tui/file-suggestions.js'
import type { TextFileReadResult } from '../src/utils/file-read.js'

const COMMANDS: CommandSummary[] = [
  { name: 'clear', description: 'clear' },
  { name: 'compact', description: 'compact' },
  { name: 'copy', description: 'copy last response' },
  { name: 'status', description: 'show status' },
]

test('detectCompletion finds a slash-command span at the line start', () =>
{
  const query = detectCompletion('/sta', 4)
  assert.deepEqual(query, { kind: 'command', token: 'sta', start: 0, end: 4 })

  const bare = detectCompletion('/', 1)
  assert.equal(bare?.kind, 'command')
  assert.equal(bare?.token, '')
})

test('detectCompletion stops treating a slash line as a command after a space', () =>
{
  assert.equal(detectCompletion('/help extra', 11), null)
})

test('detectCompletion finds an @-mention span under the cursor', () =>
{
  const query = detectCompletion('fix @src/fo', 11)
  assert.deepEqual(query, {
    kind: 'file',
    token: 'src/fo',
    start: 4,
    end: 11,
  })

  const bare = detectCompletion('@', 1)
  assert.equal(bare?.kind, 'file')
  assert.equal(bare?.token, '')
})

test('detectCompletion handles quoted @-mention spans', () =>
{
  const value = 'fix @"my docs/read'
  const query = detectCompletion(value, value.length)
  assert.deepEqual(query, {
    kind: 'file',
    token: 'my docs/read',
    start: 4,
    end: value.length,
  })
})

test('detectCompletion ignores @ that is part of a word (email-like)', () =>
{
  assert.equal(detectCompletion('mail me@example.com', 19), null)
  assert.equal(detectCompletion('plain text', 10), null)
})

test('detectCompletion tolerates leading whitespace before a slash command', () =>
{
  const query = detectCompletion('  /st', 5)
  assert.deepEqual(query, { kind: 'command', token: 'st', start: 2, end: 5 })
})

test('rankCommands puts prefix matches first & honors the cap', () =>
{
  const ranked = rankCommands('co', COMMANDS).map((item) => item.value)
  assert.deepEqual(ranked, ['compact', 'copy'])

  // empty token returns all commands (under the cap)
  assert.equal(rankCommands('', COMMANDS).length, COMMANDS.length)
})

test('rankFiles favors basename matches & shorter paths', () =>
{
  const files = ['lib/button.ts', 'src/app.ts', 'src/tui/app.tsx']
  const ranked = rankFiles('app', files).map((item) => item.value)
  assert.deepEqual(ranked, ['src/app.ts', 'src/tui/app.tsx'])

  // empty token returns files in walk order
  assert.deepEqual(
    rankFiles('', files).map((item) => item.value),
    files
  )
})

test('applyCompletion splices the choice in, keeping the sigil & adding a space', () =>
{
  const command = detectCompletion('/sta', 4)!
  const applied = applyCompletion('/sta', command, {
    value: 'status',
    label: 'status',
  })
  assert.equal(applied.value, '/status ')
  assert.equal(applied.cursorOffset, '/status '.length)

  const file = detectCompletion('fix @src/fo', 11)!
  const appliedFile = applyCompletion('fix @src/fo', file, {
    value: 'src/foo.ts',
    label: 'src/foo.ts',
  })
  assert.equal(appliedFile.value, 'fix @src/foo.ts ')

  const spaced = detectCompletion('fix @my', 7)!
  const appliedSpacedFile = applyCompletion('fix @my', spaced, {
    value: 'my docs/read me.md',
    label: 'my docs/read me.md',
  })
  assert.equal(appliedSpacedFile.value, 'fix @"my docs/read me.md" ')

  const escaped = detectCompletion('fix @quote', 10)!
  const appliedEscapedFile = applyCompletion('fix @quote', escaped, {
    value: 'src/"quoted" file.ts',
    label: 'src/"quoted" file.ts',
  })
  assert.equal(appliedEscapedFile.value, 'fix @"src/\\"quoted\\" file.ts" ')
})

test('parseMentions returns unique paths in submission order', () =>
{
  assert.deepEqual(parseMentions('see @a.ts and @b.ts then @a.ts'), [
    'a.ts',
    'b.ts',
  ])
  assert.deepEqual(
    parseMentions('see @"my docs/read me.md" and @"a.ts" then @a.ts'),
    ['my docs/read me.md', 'a.ts']
  )
  assert.deepEqual(parseMentions('see @"src/\\"quoted\\" file.ts"'), [
    'src/"quoted" file.ts',
  ])
  assert.deepEqual(parseMentions('nothing to see'), [])
  // an @ inside a word is not a mention
  assert.deepEqual(parseMentions('ping user@host'), [])
})

test('buildMentionContext attaches readable files & skips the rest', async () =>
{
  const reads: Record<string, TextFileReadResult> = {
    'a.ts': {
      ok: true,
      path: 'a.ts',
      content: 'export const a = 1',
      existed: true,
    },
    'my docs/read me.md': {
      ok: true,
      path: 'my docs/read me.md',
      content: 'spaced path',
      existed: true,
    },
    'missing.ts': {
      ok: false,
      path: 'missing.ts',
      reason: 'missing',
      message: 'gone',
    },
    'bin.dat': {
      ok: true,
      path: 'bin.dat',
      content: `binary${String.fromCharCode(0)}blob`,
      existed: true,
    },
  }
  const read = async (path: string) =>
    reads[path] ?? {
      ok: false as const,
      path,
      reason: 'missing' as const,
      message: 'gone',
    }

  const result = await buildMentionContext(
    'check @a.ts @missing.ts @bin.dat',
    read
  )
  assert.ok(result.context)
  assert.match(result.context, /===== a\.ts =====/)
  assert.match(result.context, /export const a = 1/)
  assert.deepEqual(
    result.attached.map((a) => a.path),
    ['a.ts']
  )

  const quoted = await buildMentionContext('check @"my docs/read me.md"', read)
  assert.ok(quoted.context)
  assert.match(quoted.context, /===== my docs\/read me\.md =====/)
  assert.match(quoted.context, /spaced path/)
  // missing & binary files are skipped, not injected
  assert.doesNotMatch(result.context, /missing\.ts/)
  assert.doesNotMatch(result.context, /bin\.dat/)

  // no mentions -> nothing to attach
  assert.equal(
    (await buildMentionContext('no mentions here', read)).context,
    null
  )
})

test('buildMentionContext reports a skip reason for each dropped mention', async () =>
{
  const reads: Record<string, TextFileReadResult> = {
    'big.ts': {
      ok: false,
      path: 'big.ts',
      reason: 'oversized',
      message: 'too big',
    },
    'gone.ts': {
      ok: false,
      path: 'gone.ts',
      reason: 'missing',
      message: 'gone',
    },
    'bin.dat': {
      ok: true,
      path: 'bin.dat',
      content: `x${String.fromCharCode(0)}y`,
      existed: true,
    },
  }
  const read = async (path: string) =>
    reads[path] ?? {
      ok: false as const,
      path,
      reason: 'missing' as const,
      message: 'gone',
    }

  const result = await buildMentionContext('@big.ts @gone.ts @bin.dat', read)
  assert.equal(result.context, null)
  assert.deepEqual(result.skipped, [
    { path: 'big.ts', reason: 'too large' },
    { path: 'gone.ts', reason: 'not found' },
    { path: 'bin.dat', reason: 'binary' },
  ])
})

test('buildMentionContext enforces a shared budget across mentions', async () =>
{
  const reads: Record<string, TextFileReadResult> = {
    'big1.txt': {
      ok: true,
      path: 'big1.txt',
      content: 'a'.repeat(400),
      existed: true,
    },
    'big2.txt': {
      ok: true,
      path: 'big2.txt',
      content: 'b'.repeat(400),
      existed: true,
    },
  }
  const read = async (path: string) =>
    reads[path] ?? {
      ok: false as const,
      path,
      reason: 'missing' as const,
      message: 'gone',
    }

  // budget fits part of the first file, nothing for the second
  const result = await buildMentionContext('@big1.txt @big2.txt', read, 300)
  assert.deepEqual(result.attached, [{ path: 'big1.txt', truncated: true }])
  assert.deepEqual(result.skipped, [
    { path: 'big2.txt', reason: 'over budget' },
  ])
  assert.ok(result.context)
  assert.match(result.context, /big1\.txt \(truncated\)/)
})

test('formatMentionNotice summarizes truncations & skips, else null', () =>
{
  assert.equal(
    formatMentionNotice({
      context: 'x',
      attached: [{ path: 'a.ts', truncated: false }],
      skipped: [],
    }),
    null
  )

  const notice = formatMentionNotice({
    context: 'x',
    attached: [{ path: 'big.ts', truncated: true }],
    skipped: [{ path: 'img.png', reason: 'binary' }],
  })
  assert.equal(
    notice,
    'Truncated to fit context: big.ts; skipped @-mention: img.png (binary)'
  )
})

test('isLikelyTextPath rejects only known binary extensions', () =>
{
  assert.equal(isLikelyTextPath('src/app.ts'), true)
  assert.equal(isLikelyTextPath('Makefile'), true)
  assert.equal(isLikelyTextPath('icons/logo.svg'), true)
  assert.equal(isLikelyTextPath('img/logo.png'), false)
  assert.equal(isLikelyTextPath('dist/bundle.wasm'), false)
})
