// tests/scripts/runner-outcomes.test.ts
// keep capped and timed-out dev runs from passing successful graders

import { strict as assert } from 'node:assert'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { AgentRunOutcome } from '../../src/agent/contracts.js'
import { getCwd, setCwd } from '../../src/cwd.js'
import { makeReliabilityStats } from '../../src/types/inference.js'
import { aggregateTask, runRep } from './eval/harness.js'
import type { EvalTask } from './eval/types.js'

const scratchDir = join(tmpdir(), 'coral-runner-mock-only', String(process.pid))

// mirror the settled status a real Agent reports for each mocked stop
function mockOutcome(
  mode: 'cap' | 'timeout' | 'error' | 'complete'
): AgentRunOutcome
{
  if (mode === 'error')
  {
    return { status: 'failed', error: new Error('simulated runtime failure') }
  }
  if (mode === 'cap') return { status: 'iteration_limit' }
  return { status: mode === 'timeout' ? 'cancelled' : 'completed' }
}

// keep harness workspace lifetimes and timeout callbacks entirely in memory
function mockScratchWorkspace(t: TestContext)
{
  const create = t.mock.method(fs, 'mkdtemp', async () => scratchDir)
  const remove = t.mock.method(fs, 'rm', async () =>
  {})
  syncBuiltinESMExports()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const previousCwd = getCwd()
  t.after(() =>
  {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    setCwd(previousCwd)
  })
  return { create, remove }
}

test('eval iteration limits fail successful grades and aggregation', async (t) =>
{
  const workspace = mockScratchWorkspace(t)
  let graded = 0
  let disposed = 0
  const task: EvalTask = {
    id: 'stopped-eval',
    description: 'mocked stopped outcome',
    prompt: 'finish',
    async setup(dir)
    {
      assert.equal(dir, scratchDir)
    },
    async grade({ finalText })
    {
      graded++
      assert.equal(finalText, 'partial answer')
      return { passed: true, detail: 'grader accepted partial answer' }
    },
  }

  for (const outcome of ['cap', 'timeout', 'error', 'complete'] as const)
  {
    const result = await runRep(
      'fake-model',
      task,
      { timeoutMs: 100 },
      {
        createAgent: () => ({
          async run(_prompt, events, signal)
          {
            assert.equal(signal?.aborted, false)
            if (outcome === 'cap') events.onIterationLimit?.()
            if (outcome === 'timeout')
            {
              t.mock.timers.tick(100)
              assert.equal(signal?.aborted, true)
            }
            if (outcome === 'error')
            {
              events.onError(new Error('simulated runtime failure'))
            }
            events.onDone()
            return mockOutcome(outcome)
          },
          getMessages: () => [{ role: 'assistant', content: 'partial answer' }],
          getReliabilityStats: () => makeReliabilityStats(),
          async dispose()
          {
            disposed++
          },
        }),
      }
    )
    assert.equal(result.passed, outcome === 'complete')
    assert.equal(result.aborted, outcome === 'cap' || outcome === 'timeout')
    assert.equal(result.errored, outcome === 'error')
    assert.match(result.detail, /grader accepted partial answer/)
    if (outcome === 'cap')
      assert.match(result.detail, /iteration limit reached/)
    else if (outcome === 'timeout') assert.match(result.detail, /^aborted:/)
    else if (outcome === 'error') assert.match(result.detail, /^errored:/)
    else assert.equal(result.detail, 'grader accepted partial answer')
    const aggregate = aggregateTask(task.id, [result])
    assert.equal(aggregate.passed, outcome === 'complete')
    assert.equal(aggregate.passes, outcome === 'complete' ? 1 : 0)
  }
  assert.equal(graded, 4)
  assert.equal(disposed, 4)
  assert.equal(workspace.create.mock.callCount(), 4)
  assert.equal(workspace.remove.mock.callCount(), 4)
})
