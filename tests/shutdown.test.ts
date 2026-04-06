// tests/shutdown.test.ts
// regression tests for TUI signal shutdown helpers

import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import {
  createShutdownCoordinator,
  registerSignalHandlers,
} from '../src/tui/shutdown.js'

test('registerSignalHandlers wires SIGINT & SIGTERM and unregisters cleanly', () =>
{
  const proc = new EventEmitter() as EventEmitter & {
    once(event: 'SIGINT' | 'SIGTERM', listener: () => void): EventEmitter
    off(event: 'SIGINT' | 'SIGTERM', listener: () => void): EventEmitter
  }
  let count = 0

  const unregister = registerSignalHandlers(proc, () =>
  {
    count += 1
  })

  proc.emit('SIGINT')
  assert.equal(count, 1)

  unregister()
  proc.emit('SIGTERM')
  assert.equal(count, 1)
})

test('createShutdownCoordinator runs cleanup and exit only once', async () =>
{
  const calls: string[] = []
  const shutdown = createShutdownCoordinator(
    async () =>
    {
      calls.push('cleanup')
    },
    () =>
    {
      calls.push('exit')
    }
  )

  await Promise.all([shutdown(), shutdown()])

  assert.deepEqual(calls, ['cleanup', 'exit'])
})

test('createShutdownCoordinator exits even when cleanup fails', async () =>
{
  const calls: string[] = []
  const shutdown = createShutdownCoordinator(
    async () =>
    {
      calls.push('cleanup')
      throw new Error('cleanup failed')
    },
    () =>
    {
      calls.push('exit')
    }
  )

  await assert.rejects(shutdown(), /cleanup failed/)
  assert.deepEqual(calls, ['cleanup', 'exit'])
})
