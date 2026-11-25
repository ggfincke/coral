// tests/agent/accepted-turn.test.ts
// accepted-turn guards on history mutators and the never-ran release path

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { makeAgentEvents, makeFakeAgent } from '../helpers/agent-harness.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

async function agentWithOneTurn()
{
  const harness = makeFakeAgent(await tempDir(), [
    [{ message: { role: 'assistant', content: 'ok' }, done: true }],
  ])
  await harness.agent.run('first', makeAgentEvents())
  return harness
}

test('history mutators refuse while a turn is accepted and leave undo intact', async () =>
{
  const { agent } = await agentWithOneTurn()
  const messages = agent.getMessages()
  const count = agent.getMessageCount()
  const accepted = agent.acceptTurn('second')

  const undo = await agent.undoLastTurn()
  assert.equal(undo.ok, false)
  const redo = await agent.redoLastTurn()
  assert.equal(redo.ok, false)
  assert.throws(() => agent.clearHistory(), /active turn/)
  await assert.rejects(agent.forceCompact(), /active turn/)
  assert.throws(() => agent.restoreMessages(messages), /active turn/)
  assert.throws(() => agent.restoreUndoStack([]), /active turn/)
  assert.equal(agent.getUndoStack().length, 1)
  assert.equal(agent.getMessageCount(), count + 1)

  assert.equal(agent.releaseAcceptedTurn(accepted), true)
  assert.equal((await agent.undoLastTurn()).ok, true)
})

test('releasing a never-ran turn drops its prompt and admits the next one', async () =>
{
  const { agent, streams } = await agentWithOneTurn()
  const before = agent.getMessages()
  const estimate = agent.getEstimatedTokens()

  const stranded = agent.acceptTurn('never sent')
  assert.equal(agent.releaseAcceptedTurn(stranded), true)
  assert.equal(agent.releaseAcceptedTurn(stranded), false)
  assert.deepEqual(agent.getMessages(), before)
  assert.equal(agent.getEstimatedTokens(), estimate)

  const next = agent.acceptTurn('third')
  const outcome = await agent.runAcceptedTurn(next, makeAgentEvents())
  assert.equal(outcome.status, 'completed')
  assert.equal(streams(), 2)
  assert.equal(agent.releaseAcceptedTurn(next), false)
})
