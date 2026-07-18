// tests/tui/shell.test.ts
// tests for /copy extraction helpers and shutdown cleanup guarantees

import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { lastAssistantText, lastCodeBlock } from '../../src/tui/shell/copy.js'
import {
  createShutdownCoordinator,
  registerSignalHandlers,
} from '../../src/tui/shell/shutdown.js'
import type { OllamaMessage } from '../../src/types/inference.js'

describe('/copy helpers', () =>
{
  test('lastAssistantText skips tool-call-only turns and returns the newest reply', () =>
  {
    const messages: OllamaMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'more' },
      { role: 'assistant', content: 'second answer' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'read_file', arguments: {} } }],
      },
      { role: 'tool', content: 'tool output', tool_name: 'read_file' },
    ]

    assert.equal(lastAssistantText(messages), 'second answer')
    assert.equal(lastAssistantText([{ role: 'user', content: 'hi' }]), null)
  })

  test('lastCodeBlock extracts the final fenced block', () =>
  {
    const md = 'intro\n\n```js\nconst a = 1\n```\n\nthen\n\n```py\nx = 2\n```\n'

    assert.equal(lastCodeBlock(md), 'x = 2')
    assert.equal(lastCodeBlock('just prose with `inline` only'), null)
    assert.equal(lastCodeBlock('plain paragraph text'), null)
  })
})

describe('shutdown', () =>
{
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
})
