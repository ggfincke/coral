// tests/agent/effects/replay.test.ts
// causal tests for stale replay compensation across state, todos, and disk

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { ReplayCoordinator } from '../../../src/agent/effects/replay.js'
import { ConversationState } from '../../../src/agent/state/conversation.js'
import { AgentTodoState } from '../../../src/agent/state/todos.js'
import type { TodoItem } from '../../../src/types/todo.js'
import { makeTempDirPool } from '../../helpers/temp.js'

const { tempDir } = makeTempDirPool()

const beforeTodos: TodoItem[] = [{ content: 'before', status: 'pending' }]
const afterTodos: TodoItem[] = [{ content: 'after', status: 'completed' }]

async function buildReplayFixture(prefix: string)
{
  const cwd = await tempDir(prefix)
  const edited = join(cwd, 'edited.txt')
  const created = join(cwd, 'created.txt')
  await writeFile(edited, 'after\n', 'utf-8')
  await writeFile(created, 'created\n', 'utf-8')

  const state = new ConversationState('system')
  const anchor = state.acceptUserMessage('change files and todos')
  state.appendMessage({ role: 'assistant', content: 'done' })
  state.finalizeActiveTurn(
    anchor,
    [
      { path: edited, before: 'before\n', after: 'after\n' },
      { path: created, before: null, after: 'created\n' },
    ],
    { before: beforeTodos, after: afterTodos }
  )
  const todos = new AgentTodoState(afterTodos)
  return {
    cwd,
    edited,
    created,
    state,
    todos,
    replay: new ReplayCoordinator(state, todos, cwd),
  }
}

test('stale undo compensates files and todos after caller cancellation', async () =>
{
  const fixture = await buildReplayFixture('coral-replay-undo-')
  const controller = new AbortController()
  let drifted = false
  fixture.todos.subscribe(() =>
  {
    if (drifted) return
    drifted = true
    fixture.state.appendMessage({ role: 'user', content: 'concurrent drift' })
    controller.abort()
  })

  const result = await fixture.replay.undoLastTurn(controller.signal)

  assert.deepEqual(result, {
    ok: false,
    message: 'Cannot undo after concurrent history changes',
  })
  assert.equal(await readFile(fixture.edited, 'utf-8'), 'after\n')
  assert.equal(await readFile(fixture.created, 'utf-8'), 'created\n')
  assert.deepEqual(fixture.todos.snapshot(), afterTodos)
  assert.equal(fixture.state.getMessages().at(-1)?.content, 'concurrent drift')
  assert.equal(fixture.state.getUndoStack().length, 1)
  assert.equal(fixture.state.getRedoStack().length, 0)
  assert.equal(controller.signal.aborted, true)
})

test('stale redo compensates files and todos after caller cancellation', async () =>
{
  const fixture = await buildReplayFixture('coral-replay-redo-')
  assert.equal((await fixture.replay.undoLastTurn()).ok, true)
  assert.equal(await readFile(fixture.edited, 'utf-8'), 'before\n')
  assert.equal(existsSync(fixture.created), false)

  const controller = new AbortController()
  let drifted = false
  fixture.todos.subscribe(() =>
  {
    if (drifted) return
    drifted = true
    fixture.state.appendMessage({ role: 'user', content: 'concurrent drift' })
    controller.abort()
  })

  const result = await fixture.replay.redoLastTurn(controller.signal)

  assert.deepEqual(result, {
    ok: false,
    message: 'Cannot redo after concurrent history changes',
  })
  assert.equal(await readFile(fixture.edited, 'utf-8'), 'before\n')
  assert.equal(existsSync(fixture.created), false)
  assert.deepEqual(fixture.todos.snapshot(), beforeTodos)
  assert.equal(fixture.state.getMessages().at(-1)?.content, 'concurrent drift')
  assert.equal(fixture.state.getUndoStack().length, 0)
  assert.equal(fixture.state.getRedoStack().length, 1)
  assert.equal(controller.signal.aborted, true)
})
