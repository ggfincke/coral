// tests/config/context-budget.test.ts
// memory-aware num_ctx budget sizing

import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  estimateKvBytesPerToken,
  computeMemoryCappedContext,
  resolveContextConfig,
  resolvePinnedContextWindow,
} from '../../src/config/context.js'
import type { Model, ModelInfo } from '../../src/types/inference.js'
import { makeTempDirPool } from '../helpers/temp.js'

const GiB = 1024 ** 3
const M4_MAX_MEM = 137 * 1e9
const { tempDir } = makeTempDirPool()

const tempProject = () => tempDir('coral-context-budget-')

async function withNumCtx<T>(
  value: string | undefined,
  fn: () => T | Promise<T>
): Promise<T>
{
  const original = process.env.CORAL_NUM_CTX
  if (value === undefined)
  {
    delete process.env.CORAL_NUM_CTX
  }
  else
  {
    process.env.CORAL_NUM_CTX = value
  }

  try
  {
    return await fn()
  }
  finally
  {
    if (original === undefined)
    {
      delete process.env.CORAL_NUM_CTX
    }
    else
    {
      process.env.CORAL_NUM_CTX = original
    }
  }
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

test('resolveContextConfig validates project shape before applying precedence', async () =>
{
  const emptyCwd = await tempProject()
  const malformedCwd = await tempProject()
  const validCwd = await tempProject()
  await writeFile(
    join(malformedCwd, '.coral.json'),
    JSON.stringify({ context: { maxNumCtx: '32768' } }),
    'utf8'
  )
  await writeFile(
    join(validCwd, '.coral.json'),
    JSON.stringify({ context: { maxNumCtx: 32_768 } }),
    'utf8'
  )

  await withNumCtx(undefined, () =>
  {
    assert.deepEqual(resolveContextConfig(emptyCwd), {})
    assert.deepEqual(resolveContextConfig(malformedCwd), {})
    assert.deepEqual(resolveContextConfig(validCwd), { maxNumCtx: 32_768 })
  })
  await withNumCtx('65536', () =>
  {
    assert.equal(resolveContextConfig(emptyCwd).maxNumCtx, 65_536)
    assert.deepEqual(resolveContextConfig(validCwd), { maxNumCtx: 65_536 })
  })
})

test('resolvePinnedContextWindow applies the explicit num_ctx ceiling', async () =>
{
  const cwd = await tempProject()
  await withNumCtx('65536', async () =>
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
  })
})

test('resolvePinnedContextWindow floors a too-small num_ctx override', async () =>
{
  const cwd = await tempProject()
  await withNumCtx('512', async () =>
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
  })
})

test('resolvePinnedContextWindow treats model-list failure as unknown weight', async () =>
{
  const cwd = await tempProject()
  await withNumCtx(undefined, async () =>
  {
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
