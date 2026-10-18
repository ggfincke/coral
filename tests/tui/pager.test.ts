// tests/tui/pager.test.ts
// tests for the transcript pager's pure reducer, search, highlight, and frames

import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { createElement } from 'react'
import { render } from 'ink'
import stripAnsi from 'strip-ansi'
import {
  buildPagerFooter,
  findMatchRows,
  highlightRow,
  initialPagerState,
  plainRow,
  reducePagerInput,
  type PagerKey,
  type PagerState,
} from '../../src/tui/transcript/pager.js'
import TranscriptPager from '../../src/tui/transcript/transcript-pager.js'
import type { OutputBlock } from '../../src/tui/transcript/types.js'
import { visibleWidth } from '../../src/tui/wrap.js'

const idle = () => undefined

const noKey: PagerKey = {
  ctrl: false,
  meta: false,
  tab: false,
  return: false,
  escape: false,
  backspace: false,
  delete: false,
  upArrow: false,
  downArrow: false,
  pageUp: false,
  pageDown: false,
  home: false,
  end: false,
  wheelUp: false,
  wheelDown: false,
}

function rows(count: number): string[]
{
  return Array.from({ length: count }, (_, i) => `row ${i}`)
}

function view(total: number, bodyHeight: number, plain = rows(total))
{
  return {
    total,
    bodyHeight,
    matchesFor: (query: string) => findMatchRows(plain.map(plainRow), query),
  }
}

test('pager opens pinned to the bottom, clamps every move, and holds its top as rows grow', () =>
{
  const v = view(100, 10)
  let state = initialPagerState(100, 10)
  assert.equal(state.top, 90)

  const step = (input: string, key: Partial<PagerKey> = {}) =>
  {
    const result = reducePagerInput(state, input, { ...noKey, ...key }, v)
    state = result.state
    return result
  }
  step('k')
  assert.equal(state.top, 89)
  step('', { pageUp: true })
  assert.equal(state.top, 80)
  step('u')
  assert.equal(state.top, 75)
  step('g')
  assert.equal(state.top, 0)
  step('k')
  assert.equal(state.top, 0)
  step('G')
  assert.equal(state.top, 90)
  step('j')
  assert.equal(state.top, 90)
  step('', { wheelUp: true })
  assert.equal(state.top, 87)
  step(' ')
  assert.equal(state.top, 90)

  // a reader who scrolled up keeps the same top when the total grows
  step('g')
  const grown = reducePagerInput(state, 'j', noKey, view(140, 10))
  assert.equal(grown.state.top, 1)

  assert.equal(step('q').close, true)
  assert.equal(step('', { escape: true }).close, true)
  assert.equal(step('c', { ctrl: true }).interrupt, true)
})

test('pager search accepts multi-character input, deletes graphemes, and cycles matches', () =>
{
  const corpus = [
    ...rows(20),
    'needle one',
    ...rows(30).map((row) => `${row} filler`),
    'NEEDLE two 👨‍👩‍👧',
    ...rows(10),
  ]
  const v = view(corpus.length, 8, corpus)
  let state: PagerState = { ...initialPagerState(corpus.length, 8), top: 0 }
  const step = (input: string, key: Partial<PagerKey> = {}) =>
  {
    state = reducePagerInput(state, input, { ...noKey, ...key }, v).state
  }

  step('/')
  assert.equal(state.draft, '')
  step('need')
  step('le 👨‍👩‍👧')
  assert.equal(state.draft, 'needle 👨‍👩‍👧')
  step('', { backspace: true })
  assert.equal(state.draft, 'needle ')
  step('', { backspace: true })
  // esc while typing keeps the previously committed (empty) query
  step('', { escape: true })
  assert.equal(state.draft, null)
  assert.equal(state.query, '')

  step('/')
  step('needle')
  step('', { return: true })
  assert.equal(state.query, 'needle')
  assert.equal(state.current, 20)
  assert.equal(state.top, 18)

  step('n')
  assert.equal(state.current, 51)
  step('n')
  assert.equal(state.current, 20)
  step('N')
  assert.equal(state.current, 51)

  const footer = stripAnsi(
    buildPagerFooter(state, v, v.matchesFor(state.query), 80)
  )
  assert.match(footer, /2\/2 "needle"/)
  assert.match(footer, /\d+-\d+\/62/)

  // an empty commit clears the search; a miss reports it
  step('/')
  step('', { return: true })
  assert.equal(state.query, '')
  step('/')
  step('zzz')
  step('', { return: true })
  assert.match(
    stripAnsi(buildPagerFooter(state, v, v.matchesFor('zzz'), 80)),
    /no matches "zzz"/
  )
})

test('findMatchRows ignores case and styling and highlightRow keeps the row width', () =>
{
  const styled = `\u001b[31mHello\u001b[39m World, hello again`
  assert.deepEqual(findMatchRows([plainRow(styled), 'nothing'], 'HELLO'), [0])
  const highlighted = highlightRow(styled, 'hello', true)
  assert.equal(visibleWidth(highlighted), visibleWidth(styled))
  assert.equal(stripAnsi(highlighted), 'Hello World, hello again')
  assert.equal(highlightRow(styled, 'absent', false), styled)
  assert.equal(highlightRow(styled, '', false), styled)
})

test('the pager frame shows a footer, finds matches, holds its top while rows append, and closes on q', async () =>
{
  const stdout = Object.assign(new PassThrough(), {
    columns: 80,
    rows: 20,
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
    const frame = stripAnsi(chunk.toString())
    if (frame.trim()) frames.push(frame)
  })
  const blocks: OutputBlock[] = Array.from({ length: 120 }, (_, i) =>
    i % 2 === 0
      ? { type: 'user', content: `prompt ${i}` }
      : { type: 'assistant', content: i === 61 ? 'needle here' : `reply ${i}` }
  )
  let closed = 0
  const props = (extra: OutputBlock[] = []) => ({
    transcript: { blocks: [...blocks, ...extra], streaming: '' },
    width: 80,
    height: 20,
    onClose: () =>
    {
      closed += 1
    },
    onInterrupt: idle,
  })
  const instance = render(createElement(TranscriptPager, props()), {
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
    await flush()
    const first = frames.at(-1)!
    assert.equal(first.trimEnd().split('\n').length, 20)
    assert.match(first, /transcript/)
    assert.match(first, /q closes/)
    assert.match(first, /prompt 118|reply 119/)

    stdin.write('/')
    await flush()
    stdin.write('needle')
    await flush()
    stdin.write('\r')
    await flush()
    assert.match(frames.at(-1)!, /1\/1 "needle"/)
    assert.match(frames.at(-1)!, /needle here/)
    const topRow = frames.at(-1)!.split('\n')[1]

    // appended rows leave a reader who is not at the bottom in place
    instance.rerender(
      createElement(
        TranscriptPager,
        props([{ type: 'assistant', content: 'late reply' }])
      )
    )
    await flush()
    assert.equal(frames.at(-1)!.split('\n')[1], topRow)
    assert.match(frames.at(-1)!, /↓ \d+ new/)

    stdin.write('q')
    await flush()
    assert.equal(closed, 1)
  }
  finally
  {
    instance.unmount()
    await instance.waitUntilExit()
    stdin.destroy()
    stdout.destroy()
  }
})
