// tests/tui/coalesced-input.test.ts
// several keys in one stdin read edit the composer like separate keystrokes

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import {
  createElement,
  useLayoutEffect,
  useState,
  type ReactElement,
} from 'react'
import { Box, render } from 'ink'
import PromptInput, {
  type PromptInputProps,
  type PromptReset,
} from '../../src/tui/prompt/prompt-input.js'
import {
  tapTerminalControls,
  terminalControlEvents,
} from '../../src/tui/input/control-tap.js'
import { tokenizeTerminalChunk } from '../../src/tui/input/terminal-input.js'
import { useCoralInput } from '../../src/tui/input/use-coral-input.js'
import { useTerminalModes } from '../../src/tui/input/use-terminal-modes.js'
import { resolveApprovalKey } from '../../src/tui/run/approval-box.js'

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

// fake terminal streams; one stdin.write is one Ink read
function createStreams(isTTY = false)
{
  const stdout = Object.assign(new PassThrough(), {
    columns: 80,
    rows: 24,
    isTTY,
  })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: idle,
    ref: idle,
    unref: idle,
  })
  return { stdin, stdout }
}

// render under Ink; write settles every render the read starts
async function mountInk(
  node: ReactElement,
  { stdin, stdout }: ReturnType<typeof createStreams>
)
{
  const instance = render(node, {
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
    for (let pass = 0; pass < 4; pass++)
    {
      await instance.waitUntilRenderFlush()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  await flush()
  return {
    flush,
    async write(text: string)
    {
      stdin.write(text)
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

// the real PromptInput; echoKey is written from the commit that shows
// echoAfter, and clearOnSubmit clears the draft the way App does
async function createComposer(
  options: {
    viMode?: boolean
    echoAfter?: string
    echoKey?: string
    clearOnSubmit?: boolean
  } = {}
)
{
  const streams = createStreams()
  const { stdin } = streams
  const controls = {
    value: '',
    submissions: [] as string[],
    seed: idle as (value: string) => void,
    echoed: false,
  }
  function Composer()
  {
    const [value, setValue] = useState('')
    const [reset, setReset] = useState<PromptReset>({
      epoch: 0,
      kind: 'external',
    })
    controls.value = value
    controls.seed = (draft) =>
    {
      setValue(draft)
      setReset((current) => ({ epoch: current.epoch + 1, kind: 'external' }))
    }
    useLayoutEffect(() =>
    {
      if (options.echoKey && value === options.echoAfter && !controls.echoed)
      {
        controls.echoed = true
        stdin.write(options.echoKey)
      }
    }, [value])
    return createElement(
      Box,
      { flexDirection: 'column', width: 80, height: 24 },
      createElement(PromptInput, {
        ...callbacks,
        viMode: options.viMode,
        value,
        reset,
        width: 80,
        onChange: setValue,
        onSubmit: (draft) =>
        {
          controls.submissions.push(draft)
          if (!options.clearOnSubmit) return
          setValue('')
          setReset((current) => ({
            epoch: current.epoch + 1,
            kind: 'standard',
          }))
        },
      })
    )
  }
  const ink = await mountInk(createElement(Composer), streams)
  return {
    ...ink,
    controls,
    async seed(draft: string)
    {
      controls.seed(draft)
      await ink.flush()
    },
  }
}

test('keys coalesced into one read apply in order to the latest draft', async () =>
{
  const cases = [
    { seed: 'hello', keys: '\x7f\x7f\x7f', draft: 'he', submitted: [] },
    { seed: 'xy', keys: 'ab\x7f', draft: 'xya', submitted: [] },
    { seed: 'hello', keys: '\x1b[D\x1b[DX', draft: 'helXlo', submitted: [] },
    {
      seed: 'old',
      keys: '\x1b[200~pasted text\x1b[201~\r',
      draft: 'oldpasted text',
      submitted: ['oldpasted text'],
    },
    { seed: '', keys: 'fix it\r', draft: 'fix it', submitted: ['fix it'] },
    { seed: '', keys: 'ab\t', draft: 'ab', submitted: [] },
    { seed: '', keys: '[<3', draft: '[<3', submitted: [] },
  ]
  for (const testCase of cases)
  {
    const composer = await createComposer()
    try
    {
      await composer.seed(testCase.seed)
      await composer.write(testCase.keys)
      assert.equal(composer.controls.value, testCase.draft, testCase.keys)
      assert.deepEqual(
        composer.controls.submissions,
        testCase.submitted,
        testCase.keys
      )
    }
    finally
    {
      await composer.close()
    }
  }
})

test('a key read before the previous edit settles still sees it', async () =>
{
  const composer = await createComposer({ echoAfter: 'a', echoKey: 'b' })
  try
  {
    await composer.write('a')
    assert.equal(composer.controls.echoed, true)
    assert.equal(composer.controls.value, 'ab')
  }
  finally
  {
    await composer.close()
  }
})

test('keys after a submit in the same read edit the cleared draft', async () =>
{
  const composer = await createComposer({ clearOnSubmit: true })
  try
  {
    await composer.write('a\rb\r')
    assert.deepEqual(composer.controls.submissions, ['a', 'b'])
    assert.equal(composer.controls.value, '')
  }
  finally
  {
    await composer.close()
  }
})

test('a paste under an open tool approval never answers it', async () =>
{
  const actions: string[] = []
  // the approval keys App binds, plus its lifetime paste listener
  function Approval()
  {
    useTerminalModes({ enableMouseTracking: false })
    useCoralInput((input, key) =>
    {
      const action = resolveApprovalKey('tool', input, key)
      if (action) actions.push(action)
    })
    return null
  }
  const streams = createStreams(true)
  let written = ''
  streams.stdout.on('data', (chunk: Buffer) => (written += chunk.toString()))
  const ink = await mountInk(createElement(Approval), streams)
  try
  {
    await ink.write('\x1b[200~see notes\ry\ra\rp\r\x1b[201~')
    await ink.write('n')
    assert.deepEqual(actions, ['reason'])
    assert.ok(written.includes('\x1b[?2004h'), 'bracketed paste stays on')
  }
  finally
  {
    await ink.close()
  }
})

test('a coalesced vi NORMAL run replays as separate commands', async () =>
{
  const composer = await createComposer({ viMode: true })
  try
  {
    await composer.seed('one two')
    await composer.write('0dw')
    assert.equal(composer.controls.value, 'two')
    await composer.write('ix ')
    assert.equal(composer.controls.value, 'x two')
  }
  finally
  {
    await composer.close()
  }
})

test('a read ending inside a control packet keeps it for the next read', () =>
{
  assert.deepEqual(tokenizeTerminalChunk('abc\x1b['), {
    tokens: ['abc'],
    pending: '\x1b[',
  })

  const chunks = ['\x1b[<65;1;1M\x1b', '[<64;1;1M']
  const stdin = {
    read: () => chunks.shift() ?? null,
  } as unknown as NodeJS.ReadStream
  const packets: string[] = []
  const onPacket = (packet: string) => packets.push(packet)
  terminalControlEvents.on('packet', onPacket)
  try
  {
    const tapped = tapTerminalControls(stdin)
    tapped.read()
    tapped.read()
  }
  finally
  {
    terminalControlEvents.removeListener('packet', onPacket)
  }
  assert.deepEqual(packets, ['\x1b[<65;1;1M', '\x1b[<64;1;1M'])
})
