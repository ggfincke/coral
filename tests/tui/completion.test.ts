// tests/tui/completion.test.ts
// tests for prompt completion logic & @-mention syntax

import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  applyCompletion,
  detectCompletion,
  rankCommands,
  rankFiles,
  type CommandSummary,
} from '../../src/tui/prompt/completion.js'
import {
  formatMentionNotice,
  parseMentions,
} from '../../src/tui/prompt/mentions.js'
import {
  isLikelyTextPath,
  listProjectFiles,
} from '../../src/tui/prompt/file-suggestions.js'
import { resetPromptFileSuggestions } from '../../src/tui/prompt/prompt-file-suggestions.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

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

test('rankCommands matches aliases but inserts canonical command names', () =>
{
  const ranked = rankCommands('perms', [
    {
      name: 'permissions',
      aliases: ['perms'],
      description: 'set permission mode',
    },
  ])

  assert.deepEqual(
    ranked.map((item) => item.value),
    ['permissions']
  )
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

test('listProjectFiles uses suggestion policy instead of retrieval caps', async () =>
{
  const dir = await tempDir('coral-completion-files-')
  await mkdir(join(dir, 'assets'), { recursive: true })
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'assets', 'logo.png'), 'not suggested', 'utf-8')
  await writeFile(join(dir, 'src', 'large.ts'), 'x'.repeat(600 * 1024), 'utf-8')

  const files = await listProjectFiles(dir)

  assert.ok(files.includes('src/large.ts'))
  assert.ok(!files.includes('assets/logo.png'))
})

test('listProjectFiles honors cancellation before project discovery', async () =>
{
  const dir = await tempDir('coral-completion-abort-')
  const controller = new AbortController()
  controller.abort(new DOMException('Aborted', 'AbortError'))

  await assert.rejects(listProjectFiles(dir, controller.signal), {
    name: 'AbortError',
  })
})

test('resetPromptFileSuggestions clears cwd-bound prompt file cache state', () =>
{
  assert.deepEqual(resetPromptFileSuggestions(), {
    files: [],
    filesRequested: false,
    selectedIndex: 0,
    dismissed: false,
  })
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

test('formatMentionNotice summarizes truncations & skips, else null', () =>
{
  assert.equal(
    formatMentionNotice({
      context: 'x',
      attached: [{ path: 'a.ts', truncated: false }],
      skipped: [],
      usedChars: 1,
    }),
    null
  )

  const notice = formatMentionNotice({
    context: 'x',
    attached: [{ path: 'big.ts', truncated: true }],
    skipped: [{ path: 'img.png', reason: 'binary' }],
    usedChars: 1,
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
