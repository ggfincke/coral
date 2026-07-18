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
import { parseMentions } from '../../src/tui/prompt/mentions.js'
import { collectProjectFileSuggestions } from '../../src/tui/prompt/file-suggestions.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

const COMMANDS: CommandSummary[] = [
  { name: 'clear', description: 'clear' },
  { name: 'compact', description: 'compact' },
  { name: 'copy', description: 'copy last response' },
  { name: 'status', description: 'show status' },
]

test('detectCompletion finds slash-command and @-mention spans', () =>
{
  assert.deepEqual(detectCompletion('/sta', 4), {
    kind: 'command',
    token: 'sta',
    start: 0,
    end: 4,
  })
  assert.equal(detectCompletion('/', 1)?.kind, 'command')
  assert.equal(detectCompletion('/help extra', 11), null)
  assert.deepEqual(detectCompletion('  /st', 5), {
    kind: 'command',
    token: 'st',
    start: 2,
    end: 5,
  })

  assert.deepEqual(detectCompletion('fix @src/fo', 11), {
    kind: 'file',
    token: 'src/fo',
    start: 4,
    end: 11,
  })
  const quoted = 'fix @"my docs/read'
  assert.deepEqual(detectCompletion(quoted, quoted.length), {
    kind: 'file',
    token: 'my docs/read',
    start: 4,
    end: quoted.length,
  })
  assert.equal(detectCompletion('mail me@example.com', 19), null)
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

test('project file suggestions use picker policy instead of retrieval caps', async () =>
{
  const dir = await tempDir('coral-completion-files-')
  await mkdir(join(dir, 'assets'), { recursive: true })
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'assets', 'logo.png'), 'not suggested', 'utf-8')
  await writeFile(join(dir, 'src', 'large.ts'), 'x'.repeat(600 * 1024), 'utf-8')

  const files = await collectProjectFileSuggestions(dir)

  assert.ok(files.includes('src/large.ts'))
  assert.ok(!files.includes('assets/logo.png'))
})

test('project file suggestions honor cancellation before discovery', async () =>
{
  const dir = await tempDir('coral-completion-abort-')
  const controller = new AbortController()
  controller.abort(new DOMException('Aborted', 'AbortError'))

  await assert.rejects(collectProjectFileSuggestions(dir, controller.signal), {
    name: 'AbortError',
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
