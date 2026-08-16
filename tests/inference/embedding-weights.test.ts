// tests/inference/embedding-weights.test.ts
// dual-residency extra weight bytes and Agent callback wiring

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Agent } from '../../src/agent/agent.js'
import type { AgentInferenceClient } from '../../src/agent/inference-client.js'
import { resolveDualResidencyWeightBytes } from '../../src/inference/embedding-weights.js'
import { WorkerSupervisor } from '../../src/inference/worker-supervisor.js'
import type { Model, ModelInfo } from '../../src/types/inference.js'
import { FakeWorkerTransport } from '../helpers/fake-worker.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

const SHOW: ModelInfo = {
  contextLength: 8192,
  architecture: 'gemma4',
  size: 4_000_000_000,
}

const stubClient: AgentInferenceClient = {
  startKeepAlive()
  {},
  async showModel()
  {
    return SHOW
  },
  async listModels()
  {
    return [
      {
        name: 'mlx:qwen3-coder',
        model: 'qwen3-coder',
        size: 4_000_000_000,
        modified_at: '2026-08-14T00:00:00.000Z',
      },
    ]
  },
  async *chatStream()
  {},
}

test('same Ollama chat and embed alias counts no extra weights', async () =>
{
  const extra = await resolveDualResidencyWeightBytes({
    chatBackend: 'ollama',
    chatModel: 'nomic-embed-text:latest',
    embedModel: 'ollama:nomic-embed-text',
    listOllamaModels: async () =>
    {
      throw new Error('should not list ollama models')
    },
  })
  assert.equal(extra, 0)
})

test('different Ollama chat and embed models count embed weight bytes', async () =>
{
  const extra = await resolveDualResidencyWeightBytes({
    chatBackend: 'ollama',
    chatModel: 'gemma4:31b-mlx',
    embedModel: 'ollama:nomic-embed-text',
    listOllamaModels: async () => [
      {
        name: 'nomic-embed-text:latest',
        model: 'nomic-embed-text:latest',
        size: 600_000_000,
        modified_at: '2026-08-14T00:00:00.000Z',
      },
    ],
  })
  assert.equal(extra, 600_000_000)
})

test('mlx chat plus a second mlx embed counts embed weight bytes', async () =>
{
  const transport = new FakeWorkerTransport({
    models: [
      {
        name: 'qwen3-coder',
        size: 4_000_000_000,
        modified_at: '2026-08-14T00:00:00.000Z',
      },
      {
        name: 'Qwen3-Embedding-0.6B',
        size: 600_000_000,
        modified_at: '2026-08-14T00:00:00.000Z',
      },
    ],
  })
  const worker = new WorkerSupervisor({
    transportFactory: () => transport,
    closeDelayMs: 5,
    handshakeTimeoutMs: 1_000,
  })
  try
  {
    const extra = await resolveDualResidencyWeightBytes({
      chatBackend: 'mlx',
      chatModel: 'qwen3-coder',
      embedModel: 'mlx:Qwen3-Embedding-0.6B',
      listOllamaModels: async () => [] as Model[],
      worker,
    })
    assert.equal(extra, 600_000_000)
  }
  finally
  {
    await worker.dispose()
  }
})

test('same mlx chat and embed checkpoint counts no extra weights', async () =>
{
  const extra = await resolveDualResidencyWeightBytes({
    chatBackend: 'mlx',
    chatModel: 'qwen3-coder',
    embedModel: 'mlx:qwen3-coder',
    listOllamaModels: async () =>
    {
      throw new Error('should not list')
    },
  })
  assert.equal(extra, 0)
})

test('Ollama embedding lookup treats a bare model as the :latest alias', async () =>
{
  const extra = await resolveDualResidencyWeightBytes({
    chatBackend: 'mlx',
    chatModel: 'qwen3-coder',
    embedModel: 'ollama:nomic-embed-text',
    listOllamaModels: async () => [
      {
        name: 'nomic-embed-text:latest',
        model: 'nomic-embed-text:latest',
        size: 600_000_000,
        modified_at: '2026-08-14T00:00:00.000Z',
      },
    ],
  })
  assert.equal(extra, 600_000_000)
})

test('Agent passes the current model and signal to extraWeightBytes', async () =>
{
  const dir = await tempDir('coral-extra-weight-')
  const models: string[] = []
  const signals: Array<AbortSignal | undefined> = []
  const agent = new Agent('mlx:qwen3-coder', 'http://localhost:11434', dir, {
    inferenceClient: stubClient,
    tools: [],
    extraWeightBytes: async (model, signal) =>
    {
      models.push(model)
      signals.push(signal)
      return 1_000_000
    },
  })
  try
  {
    await agent.fetchContextWindow()
    await agent.switchModel('mlx:qwen3-coder-next')
    await agent.fetchContextWindow()
    assert.deepEqual(models, ['mlx:qwen3-coder', 'mlx:qwen3-coder-next'])
    assert.equal(
      signals.every((signal) => signal instanceof AbortSignal),
      true
    )
  }
  finally
  {
    await agent.dispose()
  }
})

test('Agent disposal aborts a stuck extraWeightBytes resolution', async () =>
{
  const dir = await tempDir('coral-extra-weight-abort-')
  let callbackStarted!: () => void
  const started = new Promise<void>((resolve) =>
  {
    callbackStarted = resolve
  })
  const agent = new Agent('mlx:qwen3-coder', 'http://localhost:11434', dir, {
    inferenceClient: stubClient,
    tools: [],
    extraWeightBytes: (_model, signal) =>
      new Promise<number>(() =>
      {
        assert.ok(signal)
        callbackStarted()
      }),
  })

  const resolution = assert.rejects(agent.fetchContextWindow(), {
    name: 'AbortError',
  })
  await started
  await agent.dispose()
  await resolution
})
