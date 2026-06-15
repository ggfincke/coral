// tests/context-budget.test.ts
// memory-aware num_ctx budget sizing

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  estimateKvBytesPerToken,
  computeMemoryCappedContext,
  resolveContextConfig,
} from '../src/config/context.js'
import type { ModelInfo } from '../src/types/inference.js'

const GiB = 1024 ** 3
const M4_MAX_MEM = 137 * 1e9

// mistral-medium-3.5: full attention, exposes KV dims
const MISTRAL: ModelInfo = {
  contextLength: 262144,
  architecture: 'mistral3',
  blockCount: 88,
  kvHeadCount: 8,
  keyLength: 128,
  valueLength: 128,
}

// gemma4: sliding-window. some builds expose per-layer KV dims, but the family
// is KV-light & must not be treated as full-attention
const GEMMA: ModelInfo = {
  contextLength: 262144,
  architecture: 'gemma4',
  blockCount: 60,
  kvHeadCount: 16,
  keyLength: 256,
  valueLength: 256,
}

// unknown arch w/o KV dims — also falls through to the KV-light branch
const UNKNOWN_NO_DIMS: ModelInfo = {
  contextLength: 262144,
  architecture: 'qwen3_5_moe',
  blockCount: 48,
}

test('estimateKvBytesPerToken matches the verified full-attention figure', () =>
{
  // 88 layers * 8 kv heads * (128 + 128) dims * 2 bytes (f16)
  assert.equal(estimateKvBytesPerToken(MISTRAL), 360_448)
})

test('estimateKvBytesPerToken treats sliding-window archs as KV-light', () =>
{
  // gemma exposes KV dims here, but the SWA family must skip the estimate
  assert.equal(estimateKvBytesPerToken(GEMMA), undefined)
})

test('estimateKvBytesPerToken returns undefined when KV dims are absent', () =>
{
  assert.equal(estimateKvBytesPerToken(UNKNOWN_NO_DIMS), undefined)
})

test('full-attention model is capped well below native by the KV budget', () =>
{
  const ctx = computeMemoryCappedContext({
    totalMemBytes: M4_MAX_MEM,
    weightBytes: 80.2 * 1e9,
    nativeContext: MISTRAL.contextLength,
    kvBytesPerToken: estimateKvBytesPerToken(MISTRAL),
  })

  // ~17GB KV budget / 360448 B per token -> ~45K, far below native 256K
  assert.ok(ctx < MISTRAL.contextLength)
  assert.ok(ctx > 32_000 && ctx < 56_000, `unexpected ctx ${ctx}`)
  assert.equal(ctx % 1024, 0)
})

test('KV-light model pins native when its weights fit the budget', () =>
{
  const ctx = computeMemoryCappedContext({
    totalMemBytes: M4_MAX_MEM,
    weightBytes: 20.2 * 1e9,
    nativeContext: GEMMA.contextLength,
    kvBytesPerToken: estimateKvBytesPerToken(GEMMA),
  })

  assert.equal(ctx, GEMMA.contextLength)
})

test('weights overflowing the budget fall back to the floor', () =>
{
  const ctx = computeMemoryCappedContext({
    totalMemBytes: 16 * GiB,
    weightBytes: 20 * GiB,
    nativeContext: 262144,
    kvBytesPerToken: estimateKvBytesPerToken(MISTRAL),
  })

  assert.equal(ctx, 8_192)
})

test('the KV budget never exceeds the native window on a roomy host', () =>
{
  const ctx = computeMemoryCappedContext({
    totalMemBytes: 512 * 1e9,
    weightBytes: 80.2 * 1e9,
    nativeContext: 32_768,
    kvBytesPerToken: estimateKvBytesPerToken(MISTRAL),
  })

  assert.equal(ctx, 32_768)
})

test('resolveContextConfig returns no override when unset', () =>
{
  delete process.env.CORAL_NUM_CTX
  assert.deepEqual(resolveContextConfig(process.cwd()), {})
})

test('resolveContextConfig honors the env override', () =>
{
  process.env.CORAL_NUM_CTX = '65536'
  try
  {
    assert.equal(resolveContextConfig(process.cwd()).maxNumCtx, 65_536)
  }
  finally
  {
    delete process.env.CORAL_NUM_CTX
  }
})
