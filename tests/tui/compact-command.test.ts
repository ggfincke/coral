// tests/tui/compact-command.test.ts
// the compact command reports a failed summary request, not "too little history"

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { conversationCommands } from '../../src/tui/commands/conversation.js'
import type { CommandContext } from '../../src/tui/commands/contracts.js'
import type { OutputBlock } from '../../src/tui/transcript/types.js'
import { makeFakeAgent } from '../helpers/agent-harness.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

test('/compact prints the summarizer failure', async () =>
{
  const dir = await tempDir('coral-compact-fail-')
  const { agent } = makeFakeAgent(
    dir,
    // eslint-disable-next-line require-yield
    async function* ()
    {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
    },
    { numCtx: 8_192 }
  )
  agent.restoreMessages([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'question one' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'question two' },
    { role: 'assistant', content: 'answer two' },
  ])
  const output: OutputBlock[] = []
  let saves = 0
  const ctx = {
    agent,
    pushOutput: (...blocks: OutputBlock[]) => output.push(...blocks),
    pushTerminalOutput: (...blocks: OutputBlock[]) => output.push(...blocks),
    rebuildTranscript()
    {},
    saveCurrentSession()
    {
      saves++
      return { status: 'saved', id: 'abcd1234' }
    },
  } as unknown as CommandContext

  await conversationCommands.compact.execute('', ctx)

  const last = output.at(-1)
  assert.equal(last?.type, 'system')
  assert.match(
    (last as { content: string }).content,
    /^Compaction failed: connect ECONNREFUSED/
  )
  assert.equal(saves, 0)
  assert.equal(agent.getMessageCount(), 4)
})
