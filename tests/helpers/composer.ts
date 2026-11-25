// tests/helpers/composer.ts
// the real PromptInput under Ink with a fake stdin, for key-level tests

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
export function createStreams(isTTY = false)
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
export async function mountInk(
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
export async function createComposer(
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
