// tests/agent/request/budget.test.ts
// thinking-aware response capacity and summary budget regressions

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  requestBudgetCapacity,
  usefulLocalContextWindow,
} from '../../../src/agent/request/budget.js'

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

// the pinned local num_ctx must let the planner fill the configured prompt cap
test('the local num_ctx pin reaches the prompt cap w/ and w/o thinking', () =>
{
  assert.equal(usefulLocalContextWindow(), 37_450)
  for (const cap of [8_192, 32_768, 65_536, 131_072])
  {
    const window = usefulLocalContextWindow(cap, false)
    assert.equal(
      requestBudgetCapacity(window, undefined, cap, false).promptLimit,
      cap
    )
  }
  for (const cap of [8_192, 14_336, 16_384, 28_000, 32_768, 131_072])
  {
    const window = usefulLocalContextWindow(cap)
    assert.equal(requestBudgetCapacity(window, undefined, cap).promptLimit, cap)
  }
  assert.equal(requestBudgetCapacity(200_000, 32_000).promptLimit, 200_000)
})
