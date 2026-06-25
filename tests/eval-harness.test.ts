// tests/eval-harness.test.ts
// unit tests for the eval harness graders & aggregation (no live model)

import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  answerContains,
  readJson,
  treeContains,
  treeFreeOf,
} from './scripts/eval/grade.js'
import { aggregateModel, aggregateTask } from './scripts/eval/harness.js'
import { taskById } from './scripts/eval/tasks.js'
import { makeReliabilityStats } from '../src/types/inference.js'
import type {
  EvalTask,
  RunMetrics,
  RunOutcome,
  TaskResult,
} from './scripts/eval/types.js'
import { makeTempDirPool } from './helpers/temp.js'

const pool = makeTempDirPool()
const tempDir = () => pool.tempDir('coral-eval-test-')

// minimal but type-complete RunOutcome; override the fields a case asserts on
function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome
{
  return {
    toolCallsExecuted: 0,
    toolErrors: 0,
    reliability: makeReliabilityStats(),
    cleanlinessRate: 1,
    promptTokens: 0,
    completionTokens: 0,
    tokensPerSecond: 0,
    wallMs: 0,
    aborted: false,
    errored: false,
    passed: true,
    detail: '',
    ...overrides,
  }
}

// minimal TaskResult for aggregateModel cases; metricsOverrides patches the mean
function taskResult(
  overrides: Partial<Omit<TaskResult, 'metrics'>> = {},
  metricsOverrides: Partial<RunMetrics> = {}
): TaskResult
{
  const metrics: RunMetrics = {
    toolCallsExecuted: 0,
    toolErrors: 0,
    reliability: makeReliabilityStats(),
    cleanlinessRate: 1,
    promptTokens: 0,
    completionTokens: 0,
    tokensPerSecond: 0,
    wallMs: 0,
    aborted: false,
    errored: false,
    ...metricsOverrides,
  }
  return {
    taskId: 't',
    reps: 1,
    passes: 1,
    passed: true,
    detail: '',
    ...overrides,
    metrics,
  }
}

function requireTask(id: string): EvalTask
{
  const task = taskById(id)
  assert.ok(task)
  return task
}

describe('answerContains', () =>
{
  it('matches case-insensitively & rejects absent needles', () =>
  {
    assert.equal(answerContains('The Answer Is 42', 'answer is 42'), true)
    assert.equal(answerContains('the answer is 42', 'ANSWER'), true)
    assert.equal(answerContains('the answer is 42', 'wrong'), false)
    assert.equal(answerContains('', 'x'), false)
  })
})

describe('task graders', () =>
{
  it('rejects package replacement when single-edit should preserve fields', async () =>
  {
    const dir = await tempDir()
    const task = requireTask('single-edit')
    await task.setup(dir)
    await writeFile(join(dir, 'package.json'), '{"version":"2.4.0"}\n', 'utf-8')

    const result = await task.grade({ dir, messages: [], finalText: '' })

    assert.equal(result.passed, false)
    assert.match(result.detail, /widget@2\.4\.0/)
  })

  it('requires create-file exact contents, not trimmed contents', async () =>
  {
    const dir = await tempDir()
    const task = requireTask('create-file')
    await task.setup(dir)
    await writeFile(join(dir, 'greeting.txt'), 'hello world\n', 'utf-8')

    const result = await task.grade({ dir, messages: [], finalText: '' })

    assert.equal(result.passed, false)
    assert.match(result.detail, /hello world\\n/)
  })

  it('requires search-multi-edit output to still execute', async () =>
  {
    const dir = await tempDir()
    const task = requireTask('search-multi-edit')
    await task.setup(dir)
    await writeFile(
      join(dir, 'a.mjs'),
      "export function newName()\n{\n  return 'a'\n}\n",
      'utf-8'
    )
    await writeFile(
      join(dir, 'b.mjs'),
      "import { missing as newName } from './a.mjs'\nexport const bResult = newName()\n",
      'utf-8'
    )

    const result = await task.grade({ dir, messages: [], finalText: '' })

    assert.equal(result.passed, false)
    assert.equal(result.detail, 'renamed modules do not execute')
  })
})

describe('tree graders against a synthetic dir', () =>
{
  it('readJson parses valid json, returns null for missing & invalid', async () =>
  {
    const dir = await tempDir()
    await writeFile(join(dir, 'pkg.json'), '{"name":"coral","n":1}', 'utf-8')
    await writeFile(join(dir, 'broken.json'), '{not valid', 'utf-8')

    assert.deepEqual(await readJson(dir, 'pkg.json'), { name: 'coral', n: 1 })
    assert.equal(await readJson(dir, 'broken.json'), null)
    assert.equal(await readJson(dir, 'missing.json'), null)
  })

  it('treeContains/treeFreeOf walk text files & skip node_modules', async () =>
  {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.js'), 'export const TARGET = 1\n', 'utf-8')
    await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true })
    await writeFile(
      join(dir, 'node_modules', 'dep', 'index.js'),
      'const HIDDEN = 2\n',
      'utf-8'
    )

    // pattern present in a walked file
    assert.equal(await treeContains(dir, /TARGET/), true)
    assert.equal(await treeFreeOf(dir, /TARGET/), false)

    // pattern only inside node_modules -> not found
    assert.equal(await treeContains(dir, /HIDDEN/), false)
    assert.equal(await treeFreeOf(dir, /HIDDEN/), true)

    // pattern absent everywhere
    assert.equal(await treeContains(dir, /nowhere/), false)
    assert.equal(await treeFreeOf(dir, /nowhere/), true)
  })
})

describe('aggregateTask', () =>
{
  it('counts passes, applies the majority rule, & means numeric metrics', () =>
  {
    const runs: RunOutcome[] = [
      outcome({
        passed: true,
        detail: 'ok',
        toolCallsExecuted: 2,
        cleanlinessRate: 1,
        tokensPerSecond: 100,
        reliability: makeReliabilityStats({ nameRepairs: 2 }),
      }),
      outcome({
        passed: false,
        detail: 'first failure',
        toolCallsExecuted: 4,
        cleanlinessRate: 0.5,
        tokensPerSecond: 50,
        reliability: makeReliabilityStats({ nameRepairs: 4 }),
      }),
      outcome({
        passed: true,
        detail: 'ok2',
        toolCallsExecuted: 6,
        cleanlinessRate: 0.6,
        tokensPerSecond: 0,
        reliability: makeReliabilityStats({ nameRepairs: 0 }),
      }),
    ]

    const result = aggregateTask('demo', runs)

    assert.equal(result.taskId, 'demo')
    assert.equal(result.reps, 3)
    assert.equal(result.passes, 2)
    // 2 of 3 passed -> strict majority
    assert.equal(result.passed, true)
    // surfaces the first failing run's detail
    assert.equal(result.detail, 'first failure')
    // element-wise means across the 3 runs
    assert.equal(result.metrics.toolCallsExecuted, 4)
    assert.equal(result.metrics.tokensPerSecond, 50)
    assert.equal(result.metrics.cleanlinessRate, (1 + 0.5 + 0.6) / 3)
    assert.equal(result.metrics.reliability.nameRepairs, 2)
  })

  it('requires a strict majority & falls back to first detail when all pass', () =>
  {
    const tie = aggregateTask('tie', [
      outcome({ passed: true, detail: 'a' }),
      outcome({ passed: false, detail: 'b' }),
    ])
    assert.equal(tie.passes, 1)
    assert.equal(tie.passed, false)

    // a lone failing rep fails the task
    const lost = aggregateTask('lost', [
      outcome({ passed: false, detail: 'x' }),
    ])
    assert.equal(lost.passed, false)

    // no failures -> detail comes from the first run
    const won = aggregateTask('won', [
      outcome({ passed: true, detail: 'firstpass' }),
      outcome({ passed: true, detail: 'secondpass' }),
    ])
    assert.equal(won.passed, true)
    assert.equal(won.detail, 'firstpass')
  })

  it('does not count aborted or errored runs as passing reps', () =>
  {
    const stopped = aggregateTask('stopped', [
      outcome({ passed: true, aborted: true, detail: 'timeout' }),
      outcome({ passed: true, errored: true, detail: 'api failed' }),
      outcome({ passed: true, detail: 'ok' }),
    ])

    assert.equal(stopped.passes, 1)
    assert.equal(stopped.passed, false)
    assert.equal(stopped.detail, 'timeout')
  })
})

describe('aggregateModel', () =>
{
  it('computes passRate weighted by reps & means cleanliness/throughput', () =>
  {
    const results: TaskResult[] = [
      taskResult(
        { taskId: 'a', reps: 3, passes: 3, passed: true },
        { cleanlinessRate: 1, tokensPerSecond: 120 }
      ),
      taskResult(
        { taskId: 'b', reps: 1, passes: 0, passed: false },
        { cleanlinessRate: 0.5, tokensPerSecond: 80 }
      ),
    ]

    const report = aggregateModel('gemma', results)

    assert.equal(report.model, 'gemma')
    // weighted by reps: (3 + 0) / (3 + 1) = 0.75
    assert.equal(report.passRate, 0.75)
    assert.equal(report.meanCleanliness, (1 + 0.5) / 2)
    assert.equal(report.meanTokensPerSecond, (120 + 80) / 2)
  })

  it('yields a zero passRate for an empty result set', () =>
  {
    const report = aggregateModel('empty', [])
    assert.equal(report.passRate, 0)
    assert.equal(report.meanCleanliness, 0)
    assert.equal(report.meanTokensPerSecond, 0)
  })
})
