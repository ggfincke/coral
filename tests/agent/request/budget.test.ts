// tests/agent/request/budget.test.ts
// thinking-aware response capacity and summary budget regressions

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { requestBudgetCapacity } from '../../../src/agent/request/budget.js'

test('thinking reserves grow only for local windows at least 16k', () =>
{
  for (const [window, thinkingReserve, plainReserve] of [
    [8192, 1024, 1024],
    [16384, 4096, 2048],
    [21504, 4096, 2688],
    [65536, 8192, 8192],
    [262144, 16384, 16384],
  ] as const)
  {
    const thinking = requestBudgetCapacity(window)
    const plain = requestBudgetCapacity(window, undefined, undefined, false)
    assert.equal(thinking.responseReserve, thinkingReserve)
    assert.equal(plain.responseReserve, plainReserve)
    assert.equal(
      thinking.promptLimit,
      Math.min(32768, window - thinkingReserve)
    )
    assert.equal(thinking.summaryResponseReserve, plain.summaryResponseReserve)
    assert.equal(thinking.summaryPromptLimit, plain.summaryPromptLimit)
  }
  assert.deepEqual(
    requestBudgetCapacity(200000, 32000),
    requestBudgetCapacity(200000, 32000, undefined, false)
  )
})
