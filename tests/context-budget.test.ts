// tests/context-budget.test.ts
// memory-aware num_ctx budget sizing

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  estimateKvBytesPerToken,
  computeMemoryCappedContext,
  resolveContextConfig,
  resolvePinnedContextWindow,
} from '../src/config/context.js'
import type { Model, ModelInfo } from '../src/types/inference.js'

const GiB = 1024 ** 3
const M4_MAX_MEM = 137 * 1e9
const tempDirs: string[] = []

after(async () =>
{
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

async function tempProject(): Promise<string>
{
  const dir = await mkdtemp(join(tmpdir(), 'coral-context-budget-'))
  tempDirs.push(dir)
  return dir
}

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

test('resolvePinnedContextWindow applies the explicit num_ctx ceiling', async () =>
{
  const cwd = await tempProject()
  process.env.CORAL_NUM_CTX = '65536'
  try
  {
    const resolved = await resolvePinnedContextWindow({
      model: 'gemma4:31b-mlx',
      cwd,
      totalMemBytes: M4_MAX_MEM,
      showModel: async () => GEMMA,
      listModels: async (): Promise<Model[]> => [
        {
          name: 'gemma4:31b-mlx',
          size: 20.2 * 1e9,
          modified_at: '2026-06-17T00:00:00.000Z',
        },
      ],
    })

    assert.equal(resolved?.contextWindow, 65_536)
    assert.equal(resolved?.nativeContext, GEMMA.contextLength)
    assert.equal(resolved?.weightBytes, 20.2 * 1e9)
    assert.equal(resolved?.maxNumCtx, 65_536)
  }
  finally
  {
    delete process.env.CORAL_NUM_CTX
  }
})

test('resolvePinnedContextWindow floors a too-small num_ctx override', async () =>
{
  const cwd = await tempProject()
  process.env.CORAL_NUM_CTX = '512'
  try
  {
    const resolved = await resolvePinnedContextWindow({
      model: 'gemma4:31b-mlx',
      cwd,
      totalMemBytes: M4_MAX_MEM,
      showModel: async () => GEMMA,
      listModels: async (): Promise<Model[]> => [
        {
          name: 'gemma4:31b-mlx',
          size: 20.2 * 1e9,
          modified_at: '2026-06-17T00:00:00.000Z',
        },
      ],
    })

    // override is recorded, but the pinned window is floored at MIN_NUM_CTX
    assert.equal(resolved?.maxNumCtx, 512)
    assert.equal(resolved?.contextWindow, 8_192)
  }
  finally
  {
    delete process.env.CORAL_NUM_CTX
  }
})

test('resolvePinnedContextWindow treats model-list failure as unknown weight', async () =>
{
  const cwd = await tempProject()
  delete process.env.CORAL_NUM_CTX

  const resolved = await resolvePinnedContextWindow({
    model: 'mistral-medium-3.5:128b',
    cwd,
    totalMemBytes: 512 * 1e9,
    showModel: async () => MISTRAL,
    listModels: async () =>
    {
      throw new Error('tags unavailable')
    },
  })

  assert.equal(resolved?.contextWindow, MISTRAL.contextLength)
  assert.equal(resolved?.weightBytes, 0)
})

test('resolvePinnedContextWindow returns undefined without model metadata', async () =>
{
  const cwd = await tempProject()

  const resolved = await resolvePinnedContextWindow({
    model: 'missing:model',
    cwd,
    totalMemBytes: M4_MAX_MEM,
    showModel: async () =>
    {
      throw new Error('show failed')
    },
    listModels: async () => [],
  })

  assert.equal(resolved, undefined)
})
