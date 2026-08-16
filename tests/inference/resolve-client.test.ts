// tests/inference/resolve-client.test.ts
// composition-root client resolution and multi-backend listing

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AgentInferenceClient } from '../../src/agent/inference-client.js'
import { formatWorkerInstallError } from '../../src/config/inference.js'
import { parseModelRef } from '../../src/inference/model-ref.js'
import {
  listAvailableModels,
  resolveInferenceClient,
} from '../../src/inference/resolve-client.js'
import { WorkerSupervisor } from '../../src/inference/worker-supervisor.js'
import { withPullHint } from '../../src/utils/errors.js'
import { FakeWorkerTransport } from '../helpers/fake-worker.js'

function fakeOllama(
  models: Array<{ name: string; size: number; modified_at: string }>
): AgentInferenceClient
{
  return {
    startKeepAlive()
    {},
    async showModel()
    {
      return { contextLength: 8_192 }
    },
    async listModels()
    {
      return models.map((model) => ({ ...model, model: model.name }))
    },
    async *chatStream()
    {},
  }
}

test('mlx without a worker is an install error, not an Ollama fallback', () =>
{
  assert.throws(
    () =>
      resolveInferenceClient(parseModelRef('mlx:qwen3-coder'), {
        ollama: fakeOllama([]),
      }),
    (error: unknown) =>
    {
      assert.match(String(error), /uv sync --project packages\/coral-backend/)
      return true
    }
  )
})

test('worker-missing lists Ollama models plus one mlx warning', async () =>
{
  const listed = await listAvailableModels({
    ollama: fakeOllama([
      {
        name: 'gemma4:31b-mlx',
        size: 1,
        modified_at: '2026-08-14T00:00:00.000Z',
      },
    ]),
  })
  assert.equal(listed.models[0]?.name, 'ollama:gemma4:31b-mlx')
  assert.match(
    listed.warning ?? '',
    /uv sync --project packages\/coral-backend/
  )
})

test('listAvailableModels merges Ollama and mlx worker lists', async () =>
{
  const transport = new FakeWorkerTransport({
    models: [
      {
        name: 'qwen3-coder',
        size: 4,
        modified_at: '2026-08-14T00:00:00.000Z',
      },
    ],
  })
  const worker = new WorkerSupervisor({
    transportFactory: () => transport,
    closeDelayMs: 5,
    handshakeTimeoutMs: 1_000,
  })
  const listed = await listAvailableModels({
    ollama: fakeOllama([
      {
        name: 'gemma4:31b-mlx',
        size: 1,
        modified_at: '2026-08-14T00:00:00.000Z',
      },
    ]),
    worker,
  })
  const names = listed.models.map((model) => model.name).sort()
  assert.deepEqual(names, ['mlx:qwen3-coder', 'ollama:gemma4:31b-mlx'])
  assert.equal(listed.warning, undefined)
  await worker.dispose()
})

test('listAvailableModels starts MLX discovery while Ollama is pending', async () =>
{
  let releaseOllama!: () => void
  const ollamaPending = new Promise<void>((resolve) =>
  {
    releaseOllama = resolve
  })
  const ollama = fakeOllama([])
  ollama.listModels = async () =>
  {
    await ollamaPending
    return []
  }
  const transport = new FakeWorkerTransport()
  const worker = new WorkerSupervisor({
    transportFactory: () => transport,
    closeDelayMs: 5,
    handshakeTimeoutMs: 1_000,
  })

  const listing = listAvailableModels({ ollama, worker })
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
  assert.equal(
    transport.written.some((frame) => frame.method === 'model.list'),
    true
  )
  releaseOllama()
  const listed = await listing
  assert.equal(listed.models[0]?.name, 'mlx:qwen3-coder')
  await worker.dispose()
})

test('withPullHint keeps ollama pull for ollama refs and worker hint for mlx', () =>
{
  assert.match(
    withPullHint('missing', 'ollama:gemma4:31b-mlx', '\n'),
    /ollama pull gemma4:31b-mlx/
  )
  assert.doesNotMatch(
    withPullHint('missing', 'mlx:qwen3-coder', '\n'),
    /ollama pull/
  )
  assert.match(
    withPullHint('missing', 'mlx:qwen3-coder', '\n'),
    /uv sync --project packages\/coral-backend/
  )
  assert.equal(formatWorkerInstallError().includes('CPython 3.14'), true)
})
