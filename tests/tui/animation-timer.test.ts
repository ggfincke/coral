// tests/tui/animation-timer.test.ts
// exercise animation ticks and cleanup through the real Ink hook

import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { act, createElement, useEffect } from 'react'
import { render, Text } from 'ink'
import {
  useAnimationTimer,
  type AnimationTimerState,
} from '../../src/tui/run/use-animation-timer.js'
import type { RunStage } from '../../src/tui/run/run-stage.js'

function Harness({
  stage,
  observe,
}: {
  stage: RunStage
  observe: (state: AnimationTimerState) => void
})
{
  const state = useAnimationTimer(stage, 37)
  useEffect(() => observe(state), [observe, state])
  return createElement(
    Text,
    null,
    `${state.spinnerTick}:${state.waitingElapsed}`
  )
}

test('animation hook respects reduced motion and compaction while cleaning up ticks', async (t) =>
{
  const reactEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
  const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  t.after(() =>
  {
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  })
  const previous = {
    term: process.env.TERM,
    motion: process.env.CORAL_REDUCED_MOTION,
  }
  process.env.TERM = 'xterm-256color'
  delete process.env.CORAL_REDUCED_MOTION
  t.after(() =>
  {
    for (const [name, value] of [
      ['TERM', previous.term],
      ['CORAL_REDUCED_MOTION', previous.motion],
    ])
    {
      if (value === undefined) delete process.env[name!]
      else process.env[name!] = value
    }
  })
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const intervals = t.mock.method(globalThis, 'setInterval')
  const stdout = Object.assign(new PassThrough(), {
    columns: 80,
    rows: 24,
    isTTY: true,
  })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode()
    {},
  })
  let latest: AnimationTimerState | undefined
  const observe = (state: AnimationTimerState) =>
  {
    latest = state
  }
  let view: ReturnType<typeof render>
  await act(async () =>
  {
    view = render(
      createElement(Harness, { stage: 'tool:read_file', observe }),
      {
        stdout: stdout as NodeJS.WriteStream,
        stderr: stdout as NodeJS.WriteStream,
        stdin: stdin as NodeJS.ReadStream,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      }
    )
  })
  t.after(async () =>
  {
    await act(async () =>
    {
      view.cleanup()
    })
  })
  const animationIntervals = () =>
    intervals.mock.calls.filter((call) => call.arguments[1] === 37).length
  assert.equal(animationIntervals(), 1)
  await act(async () =>
  {
    t.mock.timers.tick(111)
  })
  assert.equal(latest!.spinnerTick, 3)

  await act(async () =>
  {
    view.rerender(createElement(Harness, { stage: 'compacting', observe }))
  })
  await act(async () =>
  {
    t.mock.timers.tick(111)
  })
  assert.equal(latest!.spinnerTick, 3)
  assert.equal(animationIntervals(), 1)
  process.env.CORAL_REDUCED_MOTION = '1'
  await act(async () =>
  {
    view.rerender(createElement(Harness, { stage: 'tool:read_file', observe }))
  })
  await act(async () =>
  {
    t.mock.timers.tick(111)
  })
  assert.equal(latest!.spinnerTick, 3)
  assert.equal(animationIntervals(), 1)

  delete process.env.CORAL_REDUCED_MOTION
  await act(async () =>
  {
    view.rerender(createElement(Harness, { stage: 'waiting', observe }))
  })
  await act(async () =>
  {
    latest!.startWaiting()
  })
  await act(async () =>
  {
    t.mock.timers.tick(74)
  })
  assert.equal(latest!.waitingElapsed, 74)
  assert.equal(latest!.showWaitingIndicator, true)
  assert.equal(animationIntervals(), 2)
  await act(async () =>
  {
    latest!.resetAnimation()
  })
  await act(async () =>
  {
    t.mock.timers.tick(74)
  })
  assert.equal(latest!.waitingElapsed, 0)
  assert.equal(latest!.showWaitingIndicator, false)
  await act(async () =>
  {
    view.rerender(createElement(Harness, { stage: 'tool:bash', observe }))
  })
  await act(async () =>
  {
    t.mock.timers.tick(37)
  })
  assert.equal(latest!.spinnerTick, 4)
  await act(async () =>
  {
    view.unmount()
  })
  const finalState = latest
  await act(async () =>
  {
    t.mock.timers.tick(111)
  })
  assert.equal(latest, finalState)
  stdin.destroy()
  stdout.destroy()
})
