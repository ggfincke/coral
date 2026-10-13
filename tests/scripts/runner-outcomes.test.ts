// tests/scripts/runner-outcomes.test.ts
// keep capped and timed-out dev runs from passing successful graders

import { strict as assert } from 'node:assert'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Agent } from '../../src/agent/agent.js'
import type { AgentInferenceClient } from '../../src/agent/inference-client.js'
import { getCwd, setCwd } from '../../src/cwd.js'
import { makeReliabilityStats } from '../../src/types/inference.js'
import { aggregateTask, runRep } from './eval/harness.js'
import type { EvalTask } from './eval/types.js'
import { ProcessTreeRssSampler } from './mlx-benchmark/process.js'
import type { BenchmarkRuntime } from './mlx-benchmark/providers.js'
import { runAgentCase } from './mlx-benchmark/suites.js'
import type { ModelPair } from './mlx-benchmark/types.js'

const scratchDir = join(tmpdir(), 'coral-runner-mock-only', String(process.pid))

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

test('MLX iteration limits and timeouts fail grades and skip the second prompt', async (t) =>
{
  const workspace = mockScratchWorkspace(t)
  const startSampler = t.mock.method(
    ProcessTreeRssSampler.prototype,
    'start',
    async () =>
    {}
  )
  const stopSampler = t.mock.method(
    ProcessTreeRssSampler.prototype,
    'stop',
    async () => []
  )
  const client: AgentInferenceClient = {
    startKeepAlive()
    {},
    showModel()
    {
      assert.fail('mocked Agent.run must not resolve model metadata')
    },
    listModels()
    {
      assert.fail('mocked Agent.run must not resolve model metadata')
    },
    chatStream()
    {
      assert.fail('mocked Agent.run must not start inference')
    },
  }
  const artifact = {
    model: 'fake-model',
    revision: 'fake-revision',
    tokenizerRevision: 'fake-tokenizer',
    chatTemplateSha256: 'fake-template',
    quantization: 'fake-quantization',
    contextWindow: 8_192,
    localPath: scratchDir,
  }
  const pair: ModelPair = {
    id: 'fake-pair',
    description: 'in-memory test pair',
    localEvidence: [],
    ollama: artifact,
    mlx: artifact,
  }
  const runtime: BenchmarkRuntime = {
    identity: {
      id: 'fake-runtime',
      kind: 'stock-mlx',
      role: 'candidate',
      description: 'in-memory test runtime',
      immutableRevision: 'fake-revision',
    },
    start()
    {
      assert.fail('mocked cases must not start a runtime')
    },
    client: async () => client,
    model: () => artifact.model,
    processRoots()
    {
      assert.fail('mocked RSS sampler must not inspect processes')
    },
    resetModel()
    {
      assert.fail('mocked cases must not reset a runtime')
    },
    crashAndRestart()
    {
      assert.fail('mocked cases must not restart a runtime')
    },
    allocatorMemory()
    {
      assert.fail('mocked cases must not sample allocator memory')
    },
    stop()
    {
      assert.fail('mocked cases must not stop a runtime')
    },
  }
  let mode: 'cap' | 'timeout' | 'error' | 'complete' = 'cap'
  let graded = 0
  const prompts: string[] = []
  const run: Agent['run'] = async function (
    this: Agent,
    input,
    events,
    signal
  )
  {
    assert.ok(typeof input === 'string')
    prompts.push(input)
    assert.equal(signal?.aborted, false)
    if (mode === 'cap') events.onIterationLimit?.()
    if (mode === 'timeout')
    {
      t.mock.timers.tick(100)
      assert.equal(signal?.aborted, true)
    }
    if (mode === 'error')
    {
      events.onError(new Error('simulated runtime failure'))
    }
    this.restoreMessages([{ role: 'assistant', content: 'partial answer' }])
    events.onDone()
  }
  t.mock.method(Agent.prototype, 'run', run)
  const task: EvalTask = {
    id: 'stopped-mlx',
    description: 'mocked stopped outcome',
    prompt: 'first prompt',
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
    mode = outcome
    prompts.length = 0
    const result = await runAgentCase({
      runtime,
      pair,
      task,
      prompt: task.prompt,
      secondPrompt: 'second prompt',
      think: false,
      contextWindow: 8_192,
      tools: [],
      permissions: {},
      limits: { maxOutputTokens: 100, requestTimeoutMs: 100 },
    })
    assert.equal(result.passed, outcome === 'complete')
    assert.match(result.detail, /grader accepted partial answer/)
    assert.deepEqual(
      prompts,
      outcome === 'complete'
        ? ['first prompt', 'second prompt']
        : ['first prompt']
    )
    if (outcome === 'cap')
      assert.match(result.detail, /iteration limit reached/)
    else if (outcome === 'timeout')
      assert.match(result.detail, /request timed out/)
    else if (outcome === 'error')
      assert.match(result.detail, /agent emitted 1 error event/)
    else assert.equal(result.detail, 'grader accepted partial answer')
  }
  assert.equal(graded, 4)
  assert.equal(startSampler.mock.callCount(), 4)
  assert.equal(stopSampler.mock.callCount(), 4)
  assert.equal(workspace.create.mock.callCount(), 4)
  assert.equal(workspace.remove.mock.callCount(), 4)
})
