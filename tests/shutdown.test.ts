// tests/shutdown.test.ts
// tests for shutdown cleanup guarantees

import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import {
  createShutdownCoordinator,
  registerSignalHandlers,
} from '../src/tui/shutdown.js'

test('registerSignalHandlers wires process signals and unregisters cleanly', () =>
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
