// tests/tui/session-picker.test.ts
// saved-session picker filtering, rendering, input, & /resume routing tests

import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import stripAnsi from 'strip-ansi'
import { dispatchCommand } from '../../src/tui/commands/registry.js'
import type { CommandContext } from '../../src/tui/commands/contracts.js'
import type { Agent } from '../../src/agent/agent.js'
import type { OutputBlock } from '../../src/tui/transcript/types.js'
import {
  buildSessionPickerLines,
  buildSessionPreviewLines,
  filterSessions,
  formatRelativeAge,
  reduceSessionPickerInput,
} from '../../src/tui/sessions/picker.js'
import { encodeSessionData } from '../../src/session/codec.js'
import { coralHomePath } from '../../src/utils/coral-home.js'
import type { OllamaMessage } from '../../src/types/inference.js'
import type { SessionData, SessionMeta } from '../../src/session/types.js'
import { makeSessionMeta } from '../helpers/session.js'
import { makeTempDirPool } from '../helpers/temp.js'
import { captureCoralHome } from '../helpers/coral-home.js'

const { tempDir, cleanup } = makeTempDirPool({ autoCleanup: false })
const restoreCoralHome = captureCoralHome()

beforeEach(async () =>
{
  const dir = await tempDir('coral-session-picker-')
  process.env.CORAL_HOME = dir
})

after(async () =>
{
  restoreCoralHome()
  await cleanup()
})

const HOUR = 3_600_000

// persist a crafted snapshot so listSessions/loadSession see controlled data
async function seedSession(
  overrides: Partial<SessionMeta> & Pick<SessionMeta, 'id' | 'updatedAt'>,
  messages: OllamaMessage[] = []
): Promise<SessionMeta>
{
  const meta = makeSessionMeta({
    cwd: process.env.CORAL_HOME ?? '/tmp',
    ...overrides,
  })
  const data: SessionData = { meta, messages }
  const dir = coralHomePath('sessions')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${meta.id}.json`),
    JSON.stringify(encodeSessionData(data))
  )
  return meta
}

function plain(lines: string[]): string
{
  return stripAnsi(lines.join('\n'))
}

test('formatRelativeAge renders compact buckets', () =>
{
  const now = Date.parse('2026-08-20T12:00:00.000Z')
  assert.equal(
    formatRelativeAge(new Date(now - 30_000).toISOString(), now),
    'now'
  )
  assert.equal(
    formatRelativeAge(new Date(now - 5 * 60_000).toISOString(), now),
    '5m'
  )
  assert.equal(
    formatRelativeAge(new Date(now - 3 * HOUR).toISOString(), now),
    '3h'
  )
  assert.equal(
    formatRelativeAge(new Date(now - 2 * 24 * HOUR).toISOString(), now),
    '2d'
  )
})

// fixtures mirror listSessions output: sorted newest-first
const pickerMetas = [
  makeSessionMeta({
    id: 'bbbb0002',
    title: 'Add retry backoff',
    updatedAt: '2026-08-21T09:00:00.000Z',
  }),
  makeSessionMeta({
    id: 'aaaa0001',
    title: 'Fix login redirect',
    updatedAt: '2026-08-20T10:00:00.000Z',
    messageCount: 4,
  }),
  makeSessionMeta({
    id: 'cccc0003',
    title: 'Refactor config loader',
    updatedAt: '2026-08-19T08:00:00.000Z',
  }),
]

test('filterSessions keeps newest-first order for an empty query', () =>
{
  assert.deepEqual(
    filterSessions(pickerMetas, '').map((session) => session.id),
    ['bbbb0002', 'aaaa0001', 'cccc0003']
  )
})

test('filterSessions narrows by title substring, fuzzy subsequence, & id', () =>
{
  assert.deepEqual(
    filterSessions(pickerMetas, 'login').map((session) => session.id),
    ['aaaa0001']
  )
  // fuzzy subsequences can span multiple titles; rank keeps insertion order
  assert.deepEqual(
    filterSessions(pickerMetas, 'flr').map((session) => session.id),
    ['aaaa0001', 'cccc0003']
  )
  assert.deepEqual(
    filterSessions(pickerMetas, 'bbbb').map((session) => session.id),
    ['bbbb0002']
  )
  assert.deepEqual(filterSessions(pickerMetas, 'zzz'), [])
})

test('ready-state lines list newest first with age, count, & preview pane', async () =>
{
  const newer = await seedSession(
    {
      id: 'eeee1111',
      updatedAt: '2026-08-21T09:00:00.000Z',
      title: 'Fix login redirect',
    },
    [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'greetings' },
    ]
  )
  const older = await seedSession({
    id: 'ffff2222',
    updatedAt: '2026-08-20T08:00:00.000Z',
    title: 'Older work',
  })

  const rendered = plain(
    buildSessionPickerLines({
      sessions: [newer, older],
      query: '',
      selectedIndex: 0,
      width: 80,
      height: 24,
    }).map((line) => stripAnsi(line))
  )

  assert.ok(rendered.includes('resume'))
  assert.ok(rendered.includes('Fix login redirect'))
  assert.ok(rendered.includes('Older work'))
  assert.ok(rendered.includes('msgs'))
  assert.ok(
    rendered.indexOf('Fix login redirect') < rendered.indexOf('Older work')
  )
  assert.ok(rendered.includes('> hello world'))
  assert.ok(rendered.includes('greetings'))

  // selecting the other row swaps the preview to that session's transcript
  const otherPreview = plain(
    buildSessionPickerLines({
      sessions: [newer, older],
      query: '',
      selectedIndex: 1,
      width: 80,
      height: 24,
    }).map((line) => stripAnsi(line))
  )
  assert.ok(!otherPreview.includes('> hello world'))

  // the whole overlay respects its viewport budget
  const capped = buildSessionPickerLines({
    sessions: [newer, older],
    query: '',
    selectedIndex: 0,
    width: 80,
    height: 8,
  })
  assert.ok(capped.length <= 8)
})

test('buildSessionPreviewLines windows the newest lines within maxRows', async () =>
{
  await seedSession({ id: 'dddd3333', updatedAt: '2026-08-21T09:00:00.000Z' }, [
    { role: 'user', content: 'first prompt' },
    { role: 'assistant', content: 'tail line one\ntail line two' },
  ])

  const preview = buildSessionPreviewLines('dddd3333', 2, 80).map(stripAnsi)
  assert.equal(preview.length, 2)
  assert.ok(!plain(preview).includes('first prompt'))
  assert.ok(preview[1]!.includes('tail line two'))

  // plain text is truncated to the width budget before styling
  const narrow = buildSessionPreviewLines('dddd3333', 10, 12).map(stripAnsi)
  assert.ok(narrow.every((line) => line.length <= 10))
})

test('reduceSessionPickerInput pages, filters, & backspaces like the palette', () =>
{
  const start = { query: '', selectedIndex: 0 }

  const paged = reduceSessionPickerInput(start, '', { pageDown: true }, 25)
  assert.equal(paged.handled, true)
  assert.equal(paged.state.selectedIndex, 10)

  const pagedUp = reduceSessionPickerInput(
    { query: '', selectedIndex: 10 },
    '',
    { pageUp: true },
    25
  )
  assert.equal(pagedUp.state.selectedIndex, 0)

  const typed = reduceSessionPickerInput(start, 'a', {}, 5)
  assert.deepEqual(typed.state, { query: 'a', selectedIndex: 0 })

  const backspaced = reduceSessionPickerInput(
    { query: 'ab', selectedIndex: 3 },
    '',
    { backspace: true },
    5
  )
  assert.deepEqual(backspaced.state, { query: 'a', selectedIndex: 0 })

  assert.equal(reduceSessionPickerInput(start, '', {}, 5).handled, false)
})

function makeCommandContext(
  overrides: Partial<CommandContext> = {}
): CommandContext
{
  return {
    agent: {} as Agent,
    activeModel: 'test-model',
    host: 'http://localhost:11434',
    yolo: false,
    sessionLabelId: null,
    pushOutput: () => undefined,
    pushTerminalOutput: () => undefined,
    clearSession()
    {},
    rebuildTranscript()
    {},
    resetTokenUsage()
    {},
    reopenModelPicker()
    {},
    switchModel: async () => ({ status: 'unchanged' }),
    getCwd: () => '/tmp/project',
    setYolo()
    {},
    exitApp()
    {},
    resumeSession: () => false,
    saveCurrentSession: () => ({ status: 'saved', id: 'abcd1234' }),
    renameCurrentSession: () => false,
    notifyThemeChanged()
    {},
    ...overrides,
  }
}

test('/resume prefix keeps direct resolution through ctx.resumeSession', async () =>
{
  const output: OutputBlock[] = []
  const resumedIds: string[] = []
  const ctx = makeCommandContext({
    pushOutput: (...blocks) => output.push(...blocks),
    resumeSession: (id) =>
    {
      resumedIds.push(id)
      return true
    },
    saveCurrentSession: () => ({ status: 'saved', id: 'current0' }),
  })

  await seedSession({
    id: 'eeee1111',
    updatedAt: '2026-08-21T09:00:00.000Z',
    title: 'Prefix target',
  })

  assert.equal(await dispatchCommand('/resume eeee', ctx), true)
  assert.deepEqual(resumedIds, ['eeee1111'])
  assert.ok(plain(output.map((block) => block.content)).includes('Resumed'))
})

test('/resume reports ambiguity & misses without touching resumeSession', async () =>
{
  const output: OutputBlock[] = []
  let resumeCalls = 0
  const ctx = makeCommandContext({
    pushOutput: (...blocks) => output.push(...blocks),
    resumeSession: () =>
    {
      resumeCalls += 1
      return true
    },
    saveCurrentSession: () => ({ status: 'saved', id: 'current0' }),
  })

  await seedSession({ id: 'aaaa1111', updatedAt: '2026-08-21T09:00:00.000Z' })
  await seedSession({ id: 'aaaa2222', updatedAt: '2026-08-20T09:00:00.000Z' })

  assert.equal(await dispatchCommand('/resume aaaa', ctx), true)
  assert.equal(resumeCalls, 0)
  assert.ok(plain(output.map((block) => block.content)).includes('Ambiguous'))

  assert.equal(await dispatchCommand('/resume dead', ctx), true)
  assert.equal(resumeCalls, 0)
  assert.ok(plain(output.map((block) => block.content)).includes('not found'))
})

test('bare /resume at the command layer still resolves latest directly', async () =>
{
  const output: OutputBlock[] = []
  const resumedIds: string[] = []
  const ctx = makeCommandContext({
    pushOutput: (...blocks) => output.push(...blocks),
    resumeSession: (id) =>
    {
      resumedIds.push(id)
      return true
    },
    saveCurrentSession: () => ({ status: 'saved', id: 'current0' }),
  })

  const oldest = await seedSession({
    id: 'bbbb1111',
    updatedAt: '2026-08-19T09:00:00.000Z',
  })
  await seedSession({
    id: 'cccc2222',
    updatedAt: '2026-08-21T09:00:00.000Z',
  })

  // the app intercepts bare /resume to open the picker; the command body
  // itself keeps today's latest-session fallback for direct dispatch callers
  assert.equal(await dispatchCommand('/resume', ctx), true)
  assert.deepEqual(resumedIds, ['cccc2222'])
  assert.ok(oldest)
})
