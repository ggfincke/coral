// tests/tui/composer-editing.test.ts
// composer undo across vi NORMAL edits and the kill-ring yank-pop span

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createComposer } from '../helpers/composer.js'

type Composer = Awaited<ReturnType<typeof createComposer>>

// a lone ESC waits out Ink's pending-escape flush before it is a key
async function escape(composer: Composer): Promise<void>
{
  await composer.write('\x1b')
  await new Promise<void>((resolve) => setTimeout(resolve, 40))
  await composer.flush()
}

test('vi NORMAL edits undo with u and with ctrl+_ after returning to INSERT', async () =>
{
  const first = await createComposer({ viMode: true })
  try
  {
    await first.write('i')
    await first.write('hello')
    await escape(first)
    await first.write('x')
    assert.equal(first.controls.value, 'hell')
    await first.write('u')
    assert.equal(first.controls.value, 'hello')
  }
  finally
  {
    await first.close()
  }

  const second = await createComposer({ viMode: true })
  try
  {
    await second.write('i')
    await second.write('hello')
    await escape(second)
    await second.write('x')
    await second.write('A')
    await second.write('\x1f')
    assert.equal(second.controls.value, 'hello')
  }
  finally
  {
    await second.close()
  }
})

test('yank-pop does nothing once the draft changed after the yank', async () =>
{
  const composer = await createComposer()
  try
  {
    // kill 'abc ' then 'x' so the ring holds two entries
    await composer.write('abc ')
    await composer.write('\x17')
    await composer.write('x')
    await composer.write('\x17')
    // yank 'x', undo it, then meta+y must not splice the old span
    await composer.write('\x16')
    assert.equal(composer.controls.value, 'x')
    await composer.write('\x1f')
    assert.equal(composer.controls.value, '')
    await composer.write('\x1by')
    assert.equal(composer.controls.value, '')
  }
  finally
  {
    await composer.close()
  }
})
