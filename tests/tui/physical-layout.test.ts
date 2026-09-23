// tests/tui/physical-layout.test.ts
// real Ink frame bounds, composer cursor visibility, and transcript scrolling

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { createElement, useState } from 'react'
import { Box, render } from 'ink'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import PromptInput, {
  type PromptInputProps,
} from '../../src/tui/prompt/prompt-input.js'
import { LineList } from '../../src/tui/components/line-list.js'
import {
  buildTranscriptLines,
  maxScrollOffset,
  padLinesTop,
  sliceViewport,
} from '../../src/tui/transcript/transcript.js'
import type { OutputBlock } from '../../src/tui/transcript/types.js'

const idle = () => undefined
const callbacks: Omit<PromptInputProps, 'value'> = {
  onChange: idle,
  onSubmit: idle,
  onEscape: idle,
  onInterrupt: idle,
  onPageUp: idle,
  onPageDown: idle,
  onJumpTop: idle,
  onJumpBottom: idle,
  onHalfPageUp: idle,
  onHalfPageDown: idle,
  onToggleToolOutput: idle,
  onScrollUp: idle,
  onScrollDown: idle,
  onToggleThinking: idle,
  onTogglePermissions: idle,
  onOpenPalette: idle,
  onHistoryUp: idle,
  onHistoryDown: idle,
}

interface FrameProps
{
  columns: number
  rows: number
  scrollOffset: number
  tick: number
  onOpenEditor?: PromptInputProps['onOpenEditor']
  viMode?: boolean
  fixedAllocation?: number
}

// mirror App's allocated composer and transcript contract with real Ink clipping
async function createFrameHarness(blocks: OutputBlock[], initial: FrameProps)
{
  const stdout = Object.assign(new PassThrough(), {
    columns: initial.columns,
    rows: initial.rows,
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
    const frame = chunk.toString()
    if (stripAnsi(frame).trim()) frames.push(frame)
  })
  const controls = {
    setDraft: idle as (value: string) => void,
    value: '',
    submissions: [] as string[],
    desired: 1,
  }
  function FrameHarness(props: FrameProps)
  {
    const [value, setValue] = useState('')
    const [desired, setDesired] = useState(1)
    controls.setDraft = setValue
    controls.value = value
    controls.desired = desired
    const maxHeight = Math.min(17, props.rows - 7)
    const allocated =
      props.fixedAllocation ?? Math.max(1, Math.min(desired, maxHeight))
    const transcriptHeight = props.rows - allocated - 2
    const transcript = buildTranscriptLines({
      blocks,
      streaming: '',
      width: props.columns,
    })
    return createElement(
      Box,
      { flexDirection: 'column', width: props.columns, height: props.rows },
      createElement(LineList, {
        lines: padLinesTop(
          sliceViewport(transcript, transcriptHeight, props.scrollOffset),
          transcriptHeight
        ),
      }),
      createElement(LineList, { lines: ['COMPOSER'] }),
      createElement(
        Box,
        { height: allocated, flexShrink: 0, overflowY: 'hidden' },
        createElement(PromptInput, {
          ...callbacks,
          onOpenEditor: props.onOpenEditor,
          viMode: props.viMode,
          value,
          width: props.columns,
          maxHeight,
          allocatedHeight: allocated,
          onHeightChange: setDesired,
          onChange: setValue,
          onSubmit: (draft) => controls.submissions.push(draft),
          completionCommands: [
            { name: 'help', description: 'List available commands' },
            { name: 'history', description: 'View session history' },
          ],
          getHistoryEntries: () => [
            { text: 'needle '.repeat(100), timestamp: 1, sessionId: null },
          ],
        })
      ),
      createElement(LineList, { lines: ['FOOTER'] })
    )
  }
  const instance = render(createElement(FrameHarness, initial), {
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
  await flush()
  return {
    frames,
    controls,
    flush,
    async input(text: string)
    {
      stdin.write(text)
      await flush()
    },
    async rerender(props: FrameProps)
    {
      stdout.columns = props.columns
      stdout.rows = props.rows
      instance.rerender(createElement(FrameHarness, props))
      await flush()
    },
    async close()
    {
      instance.unmount()
      await instance.waitUntilExit()
      stdin.destroy()
      stdout.destroy()
    },
  }
}

function assertFrames(frames: string[], columns: number, rows: number)
{
  assert.ok(frames.length > 0, 'an actual Ink frame was emitted')
  for (const frame of frames)
  {
    const lines = stripAnsi(frame).trimEnd().split('\n')
    assert.ok(
      lines.length <= rows,
      `frame has ${lines.length} rows, budget ${rows}`
    )
    assert.ok(lines.every((line) => stringWidth(line) <= columns))
    assert.ok(frame.includes('FOOTER'), 'composer did not push out the footer')
    assert.ok(frame.includes('\u001b[7m'), 'cursor is visible on every frame')
  }
}

test('physical Ink frames retain transcript rows and bound recalled drafts through resize, hints, and completion', async () =>
{
  const previousColor = chalk.level
  chalk.level = 1
  const longToken = 'unbroken'.repeat(200)
  const blocks: OutputBlock[] = [
    {
      type: 'user',
      content: `USERSTART ${'long user text '.repeat(100)} USEREND`,
    },
    { type: 'system', content: `SYSTEMSTART ${longToken} SYSTEMEND` },
  ]
  let props: FrameProps = { columns: 80, rows: 24, scrollOffset: 0, tick: 0 }
  const harness = await createFrameHarness(blocks, props)
  try
  {
    for (const [columns, rows] of [
      [50, 20],
      [80, 24],
      [100, 30],
      [120, 36],
      [120, 40],
      [40, 18],
      [24, 12],
    ])
    {
      props = { ...props, columns: columns!, rows: rows! }
      harness.controls.setDraft('')
      await harness.flush()
      await harness.rerender(props)
      harness.frames.length = 0
      harness.controls.setDraft(`RECALLED ${'word '.repeat(400)} END`)
      await harness.flush()
      assertFrames(harness.frames, props.columns, props.rows)

      const lines = buildTranscriptLines({
        blocks,
        streaming: '',
        width: props.columns,
      })
      assert.ok(lines.every((line) => stringWidth(line) <= props.columns))
      const reachable: string[] = []
      const page = 5
      for (
        let offset = maxScrollOffset(lines.length, page);
        offset >= 0;
        offset--
      )
      {
        reachable.push(...sliceViewport(lines, page, offset))
      }
      const text = stripAnsi(lines.join('')).replace(/\s/g, '')
      assert.ok(
        text.includes(longToken),
        'unbroken system content survives wrapping'
      )
      assert.ok(reachable.some((line) => stripAnsi(line).includes('USERSTART')))
      assert.ok(reachable.some((line) => stripAnsi(line).includes('SYSTEMEND')))
      harness.frames.length = 0
      await harness.rerender({ ...props, scrollOffset: lines.length })
      assertFrames(harness.frames, props.columns, props.rows)
      assert.ok(stripAnsi(harness.frames.at(-1)!).includes('USERSTART'))
    }

    // place the cursor inside the recalled draft, then resize its wrapped rows
    await harness.input('\u0001')
    await harness.input('\u001b[C')
    await harness.input('\u001b[C')
    props = { ...props, columns: 40, rows: 18, scrollOffset: 0 }
    harness.frames.length = 0
    await harness.rerender(props)
    assertFrames(harness.frames, props.columns, props.rows)
    assert.ok(
      harness.frames.at(-1)!.includes('\u001b[7mC'),
      'middle cursor remains on recalled text'
    )

    // unrelated parent updates must not repeat full-draft grapheme layout
    const segment = Intl.Segmenter.prototype.segment
    let layouts = 0
    const draft = harness.controls.value
    Intl.Segmenter.prototype.segment = function (text: string)
    {
      if (text === draft) layouts++
      return segment.call(this, text)
    }
    try
    {
      for (let tick = 1; tick <= 3; tick++)
        await harness.rerender({ ...props, tick })
      assert.equal(layouts, 0)
    }
    finally
    {
      Intl.Segmenter.prototype.segment = segment
    }

    harness.frames.length = 0
    await harness.input('\u0012')
    assertFrames(harness.frames, props.columns, props.rows)
    assert.ok(stripAnsi(harness.frames.at(-1)!).includes('Enter use'))
    await harness.input('\u0007')
    harness.controls.setDraft('')
    await harness.flush()
    harness.frames.length = 0
    await harness.input('/h')
    assertFrames(harness.frames, props.columns, props.rows)
    assert.ok(
      stripAnsi(harness.frames.at(-1)!).includes('› /help'),
      stripAnsi(harness.frames.at(-1)!)
    )
    await harness.input('\r')
    assert.equal(harness.controls.value, '/help ')
    assert.deepEqual(harness.controls.submissions, [])

    harness.controls.setDraft('')
    await harness.flush()
    await harness.rerender({ ...props, fixedAllocation: 1 })
    harness.frames.length = 0
    await harness.input('/h')
    assertFrames(harness.frames, props.columns, props.rows)
    assert.ok(
      harness.controls.desired > 1,
      'desired height stays independent of allocation'
    )
    assert.ok(!stripAnsi(harness.frames.at(-1)!).includes('› /help'))
    await harness.input('\r')
    assert.deepEqual(
      harness.controls.submissions,
      ['/h'],
      'hidden suggestions do not consume Enter'
    )
  }
  finally
  {
    await harness.close()
    chalk.level = previousColor
  }
})

test('composer preserves wrapped drafts, paste confirmation, and editor contents through real input routing', async () =>
{
  let editorDraft = ''
  let editorCancelled = false
  const props: FrameProps = {
    columns: 20,
    rows: 24,
    scrollOffset: 0,
    tick: 0,
    onOpenEditor: async (draft) =>
    {
      editorDraft = draft
      return editorCancelled ? null : draft + '\nedited'
    },
  }
  const harness = await createFrameHarness([], props)
  try
  {
    const wrapped = '1234567890'.repeat(4)
    await harness.input(wrapped)
    await harness.input('\x1b[A')
    await harness.input('X')
    assert.equal(
      harness.controls.value,
      wrapped.slice(0, 20) + 'X' + wrapped.slice(20)
    )
    await harness.rerender({ ...props, columns: 10 })
    await harness.input('\x1b[A')
    await harness.input('Y')
    assert.equal(harness.controls.value.indexOf('Y'), 11)
    assert.equal(harness.controls.value.replace(/[XY]/g, ''), wrapped)
    harness.controls.setDraft('')
    await harness.flush()
    await harness.rerender({ ...props, columns: 80 })
    await harness.input('\x1b[200~alpha\nbeta\x1b[201~')
    assert.equal(harness.controls.value, 'alpha\nbeta')
    await harness.input('!')
    await harness.input('\r')
    assert.deepEqual(harness.controls.submissions, [])
    await harness.input('\r')
    assert.deepEqual(harness.controls.submissions, ['alpha\nbeta!'])
    harness.controls.setDraft('')
    await harness.flush()
    const large = 'expanded '.repeat(140)
    await harness.input('\x1b[200~' + large + '\x1b[201~')
    const placeholder = harness.controls.value
    assert.match(placeholder, /Pasted text/)
    await harness.input('\x07')
    assert.equal(editorDraft, large)
    assert.equal(harness.controls.value, large + '\nedited')
    await harness.input('\x1f')
    assert.equal(harness.controls.value, placeholder)
    editorCancelled = true
    await harness.input('\x07')
    assert.equal(harness.controls.value, placeholder)
    await harness.input('\r')
    assert.equal(harness.controls.submissions.length, 1)
    await harness.input('\r')
    assert.equal(harness.controls.submissions.at(-1), large)
    harness.controls.setDraft('')
    await harness.flush()
    await harness.rerender({ ...props, columns: 80, viMode: true })
    await harness.input('i')
    await harness.input('abc')
    await harness.input('\x1b[D')
    await harness.input('X')
    assert.equal(harness.controls.value, 'abXc')
    await harness.input('\r')
    assert.equal(harness.controls.value, 'abX\nc')
    harness.controls.setDraft('')
    await harness.flush()
    await harness.input('/h')
    await harness.input('\x1b[B')
    await harness.input('\r')
    assert.equal(harness.controls.value, '/history ')
    assert.equal(harness.controls.submissions.length, 2)
    harness.controls.setDraft('')
    await harness.flush()
    await harness.input('\x1b[200~safe\npaste\x1b[201~')
    await harness.input('\x1b')
    // allow Ink to distinguish bare escape from an alt chord after its 20 ms delay
    await new Promise((resolve) => setTimeout(resolve, 30))
    await harness.flush()
    await harness.input(':')
    await harness.input('w')
    await harness.input('q')
    await harness.input('\r')
    assert.equal(harness.controls.submissions.length, 2)
    await harness.input('\r')
    assert.equal(
      harness.controls.submissions.at(-1),
      'safe\npaste',
      stripAnsi(harness.frames.at(-1)!)
    )
  }
  finally
  {
    await harness.close()
  }
})
