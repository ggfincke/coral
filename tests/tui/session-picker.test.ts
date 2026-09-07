// tests/tui/session-picker.test.ts
// saved-session picker filtering, rendering, input, & /resume routing tests

import { strict as assert } from 'node:assert'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { after, beforeEach, test } from 'node:test'
import stripAnsi from 'strip-ansi'
import { dispatchCommand } from '../../src/tui/commands/registry.js'
import type { CommandContext } from '../../src/tui/commands/contracts.js'
import type { Agent } from '../../src/agent/agent.js'
import type { OutputBlock } from '../../src/tui/transcript/types.js'
import SessionPicker, {
  buildSessionPickerLines,
  buildSessionPreviewTail,
  SessionPreviewLoader,
  buildSessionPreviewLines,
  filterSessions,
  formatRelativeAge,
  reduceSessionPickerInput,
} from '../../src/tui/sessions/picker.js'
import { encodeSessionData } from '../../src/session/codec.js'
import { loadSessionPreview } from '../../src/session/store.js'
import { formatBlocksPlain } from '../../src/tui/transcript/plain.js'
import { buildRestoredBlocks } from '../../src/tui/transcript/restored-blocks.js'
import { coralHomePath } from '../../src/utils/coral-home.js'
import type { OllamaMessage } from '../../src/types/inference.js'
import type {
  SessionData,
  SessionMeta,
  SessionPreviewResult,
} from '../../src/session/types.js'
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

  const loaded = await loadSessionPreview(newer.id)
  assert.equal(loaded.kind, 'loaded')
  if (loaded.kind !== 'loaded') assert.fail('fixture must load')
  const previewLines = buildSessionPreviewTail(loaded.messages, 24).lines
  const rendered = plain(
    buildSessionPickerLines({
      sessions: [newer, older],
      query: '',
      selectedIndex: 0,
      width: 80,
      height: 24,
      previewLines,
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

  const loaded = await loadSessionPreview('dddd3333')
  assert.equal(loaded.kind, 'loaded')
  if (loaded.kind !== 'loaded') assert.fail('fixture must load')
  const lines = buildSessionPreviewTail(loaded.messages, 10).lines
  const preview = buildSessionPreviewLines(lines, 2, 80).map(stripAnsi)
  assert.equal(preview.length, 2)
  assert.ok(!plain(preview).includes('first prompt'))
  assert.ok(preview[1]!.includes('tail line two'))

  // plain text is truncated to the width budget before styling
  const narrow = buildSessionPreviewLines(lines, 10, 12).map(stripAnsi)
  assert.ok(narrow.every((line) => line.length <= 10))
})

test('backward preview tails preserve plain transcript policy without formatting older messages', () =>
{
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'hidden instructions' },
    {
      role: 'user',
      content: 'expanded attachment body',
      displayContent: 'inspect @missing.ts',
      attachmentReport: {
        attached: [],
        skipped: [{ path: 'missing.ts', reason: 'not found' }],
      },
    },
    {
      role: 'assistant',
      content: 'answer\nwith a second line',
      thinking: 'reasoning\ncontinued',
    },
    {
      role: 'tool',
      tool_name: 'bash',
      content: 'output\n\u001b[2Jstill plain',
    },
    { role: 'assistant', content: 'final answer' },
  ]
  const all = formatBlocksPlain(buildRestoredBlocks(messages))
  for (const budget of [1, 8, 100])
  {
    const tail = buildSessionPreviewTail(messages, budget)
    assert.deepEqual(tail.lines, all.slice(-budget))
    assert.equal(tail.complete, all.length <= budget)
  }
  assert.ok(plain(all).includes('inspect @missing.ts'))
  assert.ok(plain(all).includes('Skipped @-mention'))
  assert.ok(!plain(all).includes('expanded attachment body'))

  const visited = new Set<number>()
  const history: OllamaMessage[] = Array.from({ length: 1000 }, (_, index) => ({
    role: 'assistant',
    get content()
    {
      visited.add(index)
      return `line ${index}`
    },
  }))
  assert.deepEqual(buildSessionPreviewTail(history, 3).lines, [
    'line 997',
    'line 998',
    'line 999',
  ])
  assert.equal(visited.size, 3)
})

test('preview loader revalidates replacements and bounds cache admission without clipping display', async () =>
{
  const meta = await seedSession(
    { id: 'abcd4444', updatedAt: '2026-08-21T09:00:00.000Z' },
    [{ role: 'assistant', content: 'one\ntwo\nthree\nfour' }]
  )
  const revisions: Array<string | undefined> = []
  const loader = new SessionPreviewLoader((id, options) =>
  {
    revisions.push(options?.knownRevision)
    return loadSessionPreview(id, options)
  })
  const first = await loader.load(meta.id, 2)
  assert.deepEqual(first?.lines, ['three', 'four'])
  const unchanged = await loader.load(meta.id, 2)
  assert.equal(unchanged, first)
  assert.ok(revisions[1])
  assert.ok(
    buildSessionPreviewLines(unchanged!.lines, 2, 10).every(
      (line) => stripAnsi(line).length <= 8
    )
  )
  const larger = await loader.load(meta.id, 10)
  assert.deepEqual(larger?.lines, ['one', 'two', 'three', 'four'])
  assert.equal(
    revisions[2],
    undefined,
    'a larger uncovered tail reloads messages'
  )

  const target = coralHomePath('sessions', `${meta.id}.json`)
  const replacement = target + '.replacement'
  await writeFile(
    replacement,
    JSON.stringify(
      encodeSessionData({
        meta,
        messages: [
          { role: 'assistant', content: 'atomic replacement preview' },
        ],
      })
    )
  )
  await rename(replacement, target)
  assert.deepEqual((await loader.load(meta.id, 10))?.lines, [
    'atomic replacement preview',
  ])
  assert.ok(
    revisions[3],
    'replacement checks still start with the known revision'
  )
  loader.dispose()
  await loader.load(meta.id, 10)
  assert.equal(revisions[4], undefined, 'unmount clears retained preview data')
  loader.dispose()

  let result: SessionPreviewResult = {
    kind: 'loaded',
    revision: 'fixture',
    messages: [{ role: 'assistant', content: 'x'.repeat(256 * 1024) }],
  }
  const admitted: Array<string | undefined> = []
  const bounded = new SessionPreviewLoader(async (_id, options) =>
  {
    admitted.push(options?.knownRevision)
    return result
  })
  const oversized = await bounded.load('oversized', 1)
  assert.equal(oversized?.lines[0]?.length, 256 * 1024)
  await bounded.load('oversized', 1)
  assert.equal(
    admitted.at(-1),
    undefined,
    'oversized bytes remain displayable but uncached'
  )
  result = {
    kind: 'loaded',
    revision: 'many rows',
    messages: [
      { role: 'assistant', content: Array(300).fill('row').join('\n') },
    ],
  }
  assert.equal((await bounded.load('rows', 300))?.lines.length, 300)
  await bounded.load('rows', 300)
  assert.equal(
    admitted.at(-1),
    undefined,
    'oversized row counts are not retained'
  )
  result = {
    kind: 'loaded',
    revision: null,
    messages: [{ role: 'assistant', content: 'raced but valid' }],
  }
  assert.deepEqual((await bounded.load('raced', 1))?.lines, ['raced but valid'])
  await bounded.load('raced', 1)
  assert.equal(
    admitted.at(-1),
    undefined,
    'a raced snapshot cannot establish a revision'
  )
  bounded.dispose()
})

test('preview selection and unmount abort work and reject late results', async () =>
{
  const requests: Array<{
    signal: AbortSignal | undefined
    resolve: (result: SessionPreviewResult) => void
    knownRevision: string | undefined
  }> = []
  const loader = new SessionPreviewLoader(
    (_id, options) =>
      new Promise((resolve) =>
      {
        requests.push({
          signal: options?.signal,
          resolve,
          knownRevision: options?.knownRevision,
        })
      })
  )
  const oldSelection = loader.load('old', 3)
  const currentSelection = loader.load('current', 3)
  assert.equal(requests[0]!.signal?.aborted, true)
  requests[1]!.resolve({
    kind: 'loaded',
    revision: 'current',
    messages: [{ role: 'assistant', content: 'current preview' }],
  })
  assert.deepEqual((await currentSelection)?.lines, ['current preview'])
  requests[0]!.resolve({
    kind: 'loaded',
    revision: 'old',
    messages: [{ role: 'assistant', content: 'stale preview' }],
  })
  assert.equal(await oldSelection, undefined)
  const refresh = loader.load('current', 3)
  assert.equal(
    requests[2]!.knownRevision,
    'current',
    'late data did not replace the selected cache'
  )
  loader.dispose()
  assert.equal(requests[2]!.signal?.aborted, true)
  requests[2]!.resolve({ kind: 'unchanged', revision: 'current' })
  assert.equal(await refresh, undefined)
})

test('picker clears changing selections immediately and preserves previews at navigation boundaries', async (t) =>
{
  await seedSession({
    id: 'aaaa5555',
    updatedAt: '2026-08-21T09:00:00.000Z',
    title: 'Newest',
  })
  await seedSession({
    id: 'bbbb5555',
    updatedAt: '2026-08-20T09:00:00.000Z',
    title: 'Older',
  })
  const requests: Array<{
    id: string
    resolve: (tail: { lines: string[]; complete: boolean }) => void
  }> = []
  t.mock.method(
    SessionPreviewLoader.prototype,
    'load',
    (id: string) =>
      new Promise((resolve) =>
      {
        requests.push({ id, resolve })
      })
  )
  const idle = () => undefined
  const stdout = Object.assign(new PassThrough(), {
    columns: 80,
    rows: 24,
    isTTY: false,
  })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: idle,
    ref: idle,
    unref: idle,
  })
  const frames: string[] = []
  stdout.on('data', (chunk: Buffer) =>
  {
    if (stripAnsi(chunk.toString()).trim())
      frames.push(stripAnsi(chunk.toString()))
  })
  const resumed: string[] = []
  const pickerProps = {
    width: 80,
    height: 24,
    onResume: (id: string) => resumed.push(id),
    onClose: idle,
  }
  const instance = render(createElement(SessionPicker, pickerProps), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
    interactive: false,
  })
  async function flush()
  {
    for (let pass = 0; pass < 3; pass++)
    {
      await instance.waitUntilRenderFlush()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  try
  {
    const deadline = Date.now() + 2000
    while (requests.length === 0 && Date.now() < deadline)
    {
      await flush()
      if (requests.length === 0)
        await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.equal(requests[0]?.id, 'aaaa5555')
    requests[0]!.resolve({ lines: ['NEWEST PREVIEW'], complete: true })
    await flush()
    assert.ok(frames.at(-1)?.includes('NEWEST PREVIEW'))
    stdin.write('\u001b[A')
    await flush()
    assert.equal(requests.length, 1)
    assert.ok(
      frames.at(-1)?.includes('NEWEST PREVIEW'),
      'a clamped arrow keeps the loaded preview'
    )

    stdin.write('\u001b[B')
    await flush()
    assert.equal(requests[1]?.id, 'bbbb5555')
    assert.ok(!frames.at(-1)?.includes('NEWEST PREVIEW'))
    stdin.write('\u001b[A')
    await flush()
    assert.equal(requests[2]?.id, 'aaaa5555')
    requests[1]!.resolve({ lines: ['STALE OLDER PREVIEW'], complete: true })
    await flush()
    assert.ok(!frames.at(-1)?.includes('STALE OLDER PREVIEW'))
    requests[2]!.resolve({ lines: ['CURRENT NEWEST PREVIEW'], complete: true })
    await flush()
    assert.ok(frames.at(-1)?.includes('CURRENT NEWEST PREVIEW'))
    instance.rerender(
      createElement(SessionPicker, { ...pickerProps, width: 40 })
    )
    await flush()
    assert.equal(
      requests[3]?.id,
      'aaaa5555',
      'geometry changes revalidate the selected file'
    )
    requests[3]!.resolve({ lines: ['CURRENT NEWEST PREVIEW'], complete: true })
    await flush()
    stdin.write('N')
    await flush()
    assert.equal(
      requests[4]?.id,
      'aaaa5555',
      'query changes revalidate even when selection stays the same'
    )
    requests[4]!.resolve({ lines: ['CURRENT NEWEST PREVIEW'], complete: true })
    await flush()
    stdin.write('\r')
    await flush()
    assert.deepEqual(resumed, ['aaaa5555'])
  }
  finally
  {
    instance.unmount()
    await instance.waitUntilExit()
    stdin.destroy()
    stdout.destroy()
  }
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
