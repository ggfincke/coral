// tests/inference/worker-e2e.test.ts
// real-spawn python worker via supervisor; skipped unless CORAL_WORKER_E2E=1

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseModelRef } from '../../src/inference/model-ref.js'
import { PythonInferenceClient } from '../../src/inference/python-client.js'
import { PythonEmbedder } from '../../src/inference/python-embedder.js'
import { WorkerSupervisor } from '../../src/inference/worker-supervisor.js'
import { createMlxEmbeddingSpace } from '../../src/retrieval/embedding-space.js'
import type { ChatResponse } from '../../src/types/inference.js'
import { makeTempDirPool } from '../helpers/temp.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BACKEND_PROJECT = resolve(REPO_ROOT, 'packages/coral-backend')
const VENV_PYTHON = resolve(BACKEND_PROJECT, '.venv/bin/python')
const MLX = parseModelRef('mlx:gemma4-demo')
const E2E_SKIP = workerE2eSkipReason()
const { tempDir } = makeTempDirPool()

const e2e = {
  skip: E2E_SKIP,
  timeout: 30_000,
}

// §8 failure-mode map lives in packages/coral-backend/README.md

function workerE2eSkipReason(): string | false
{
  if (process.env.CORAL_WORKER_E2E !== '1')
  {
    return 'set CORAL_WORKER_E2E=1 to spawn the real Python worker'
  }
  if (!existsSync(resolve(BACKEND_PROJECT, 'pyproject.toml')))
  {
    return 'packages/coral-backend is missing'
  }
  if (existsSync(VENV_PYTHON)) return false
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8' })
  if (uv.status !== 0)
  {
    return 'uv is not available on PATH and packages/coral-backend/.venv is missing'
  }
  return false
}

function processAlive(pid: number): boolean
{
  try
  {
    process.kill(pid, 0)
    return true
  }
  catch
  {
    return false
  }
}

function childPids(pid: number): number[]
{
  const result = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout.trim()) return []
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => Number(line))
    .filter((value) => Number.isInteger(value) && value > 0)
}

function killTree(pid: number): void
{
  if (process.platform !== 'win32')
  {
    try
    {
      process.kill(-pid, 'SIGKILL')
      return
    }
    catch
    {
      // process may not be a group leader
    }
  }
  try
  {
    process.kill(pid, 'SIGKILL')
  }
  catch
  {
    // already gone
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void>
{
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline)
  {
    if (predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function writeCheckpoint(root: string, name: string): Promise<void>
{
  const dir = resolve(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    resolve(dir, 'config.json'),
    JSON.stringify({
      model_type: 'gemma4',
      max_position_embeddings: 131072,
      num_hidden_layers: 48,
      num_key_value_heads: 8,
      head_dim: 256,
      hidden_size: 4096,
      num_attention_heads: 16,
    })
  )
  await writeFile(resolve(dir, 'model.safetensors'), Buffer.alloc(2048))
}

async function connectRealWorker(options: {
  fake: Record<string, unknown>
  modelsDir: string
}): Promise<{
  client: PythonInferenceClient
  worker: WorkerSupervisor
}>
{
  const scriptDir = await tempDir('coral-worker-e2e-script-')
  const scriptPath = resolve(scriptDir, 'fake.json')
  await writeFile(scriptPath, JSON.stringify(options.fake))
  const extraEnv: NodeJS.ProcessEnv = {
    CORAL_FAKE_GENERATE: scriptPath,
    CORAL_MLX_MODELS_DIR: options.modelsDir,
  }
  if (existsSync(VENV_PYTHON)) extraEnv.CORAL_PYTHON = VENV_PYTHON
  const worker = new WorkerSupervisor({
    repoRoot: REPO_ROOT,
    extraEnv,
    closeDelayMs: 1_000,
    handshakeTimeoutMs: 20_000,
  })
  return { client: new PythonInferenceClient(worker, MLX), worker }
}

test(
  'real worker handshake advertises phase-2 methods and versions',
  e2e,
  async () =>
  {
    const modelsDir = await tempDir('coral-worker-e2e-models-')
    await writeCheckpoint(modelsDir, 'gemma4-demo')
    const { client, worker } = await connectRealWorker({
      fake: { chunks: [{ content: 'ok' }] },
      modelsDir,
    })
    try
    {
      await worker.ensure()
      const handshake = worker.handshakeResult()
      assert.equal(handshake?.protocolVersion, 1)
      assert.deepEqual(handshake?.methods, [
        'chat.start',
        'model.list',
        'model.show',
        'embed',
      ])
      assert.ok(handshake?.versions.python)
      assert.equal(handshake?.methods.includes('embed'), true)
      const models = await client.listModels()
      assert.equal(models[0]?.name, 'mlx:gemma4-demo')
      assert.equal(models[0]?.size, 2048)
      const info = await client.showModel('mlx:gemma4-demo')
      assert.equal(info.contextLength, 131072)
      assert.equal(info.architecture, 'gemma4')
      assert.equal(info.size, 2048)
      assert.equal(info.blockCount, 48)
      assert.equal(info.kvHeadCount, 8)
      assert.equal(typeof info.digest, 'string')
      assert.match(info.digest ?? '', /^[a-f0-9]{64}$/)
    }
    finally
    {
      await worker.dispose()
    }
  }
)

test(
  'real worker chatStream preserves function.index and nanosecond durations',
  e2e,
  async () =>
  {
    const modelsDir = await tempDir('coral-worker-e2e-models-')
    await writeCheckpoint(modelsDir, 'gemma4-demo')
    const { client, worker } = await connectRealWorker({
      fake: {
        prompt_eval_count: 12,
        prompt_eval_duration: 1_000_000_000,
        eval_count: 8,
        eval_duration: 2_000_000_000,
        chunks: [
          { content: 'Looking ' },
          {
            tool_calls: [
              {
                index: 0,
                name: 'read_file',
                arguments: { path: 'hel' },
              },
            ],
          },
          {
            tool_calls: [
              {
                index: 0,
                name: 'read_file',
                arguments: { path: 'hello' },
              },
            ],
          },
        ],
      },
      modelsDir,
    })
    try
    {
      const chunks: ChatResponse[] = []
      for await (const chunk of client.chatStream({
        model: 'mlx:gemma4-demo',
        messages: [{ role: 'user', content: 'find hello' }],
      }))
      {
        chunks.push(chunk)
      }
      const indexed = chunks.filter((chunk) => chunk.message.tool_calls?.length)
      assert.ok(indexed.length >= 2)
      assert.equal(indexed[0]?.message.tool_calls?.[0]?.function.index, 0)
      assert.equal(indexed.at(-1)?.message.tool_calls?.[0]?.function.index, 0)
      assert.deepEqual(
        indexed.at(-1)?.message.tool_calls?.[0]?.function.arguments,
        {
          path: 'hello',
        }
      )
      const done = chunks.at(-1)
      assert.equal(done?.done, true)
      assert.equal(done?.prompt_eval_duration, 1_000_000_000)
      assert.equal(done?.eval_duration, 2_000_000_000)
    }
    finally
    {
      await worker.dispose()
    }
  }
)

test(
  'cancel mid-stream ends the request and leaves the worker healthy',
  e2e,
  async () =>
  {
    const modelsDir = await tempDir('coral-worker-e2e-models-')
    await writeCheckpoint(modelsDir, 'gemma4-demo')
    const { client, worker } = await connectRealWorker({
      fake: {
        chunks: [
          { content: 'one', delay_ms: 20 },
          { content: 'two', delay_ms: 2_000 },
          { content: 'three', delay_ms: 2_000 },
        ],
      },
      modelsDir,
    })
    try
    {
      const controller = new AbortController()
      const chunks: ChatResponse[] = []
      const consume = (async () =>
      {
        for await (const chunk of client.chatStream(
          {
            model: 'mlx:gemma4-demo',
            messages: [{ role: 'user', content: 'go' }],
          },
          controller.signal
        ))
        {
          chunks.push(chunk)
          if (chunk.message.content.includes('one')) controller.abort()
        }
      })()
      await assert.rejects(consume, { name: 'AbortError' })
      const pid = worker.pid()
      assert.ok(pid && processAlive(pid))
      const models = await client.listModels()
      assert.equal(models[0]?.name, 'mlx:gemma4-demo')
    }
    finally
    {
      await worker.dispose()
    }
  }
)

test(
  'closing chatStream early cancels generation and leaves the worker healthy',
  e2e,
  async () =>
  {
    const modelsDir = await tempDir('coral-worker-e2e-models-')
    await writeCheckpoint(modelsDir, 'gemma4-demo')
    const { client, worker } = await connectRealWorker({
      fake: {
        chunks: [
          { content: 'one', delay_ms: 20 },
          { content: 'two', delay_ms: 2_000 },
          { content: 'three', delay_ms: 2_000 },
        ],
      },
      modelsDir,
    })
    try
    {
      for await (const chunk of client.chatStream({
        model: 'mlx:gemma4-demo',
        messages: [{ role: 'user', content: 'go' }],
      }))
      {
        if (chunk.message.content.includes('one')) break
      }

      const models = await client.listModels()
      assert.equal(models[0]?.name, 'mlx:gemma4-demo')
    }
    finally
    {
      await worker.dispose()
    }
  }
)

test(
  'supervisor restarts once after the real child dies, then stays dead',
  e2e,
  async () =>
  {
    const modelsDir = await tempDir('coral-worker-e2e-models-')
    await writeCheckpoint(modelsDir, 'gemma4-demo')
    const { client, worker } = await connectRealWorker({
      fake: { chunks: [{ content: 'ok' }] },
      modelsDir,
    })
    try
    {
      await worker.ensure()
      const first = worker.pid()
      assert.ok(first)
      killTree(first)
      await waitFor(
        () => worker.pid() !== undefined && worker.pid() !== first,
        10_000,
        'worker restart pid'
      )
      const models = await client.listModels()
      assert.equal(models[0]?.name, 'mlx:gemma4-demo')
      const second = worker.pid()
      assert.ok(second)
      killTree(second)
      await waitFor(
        () => worker.pid() === undefined,
        10_000,
        'second crash to drop the worker pid'
      )
      await assert.rejects(
        () => worker.ensure(),
        /crashed again after one restart/
      )
    }
    finally
    {
      await worker.dispose()
    }
  }
)

test('dispose joins the real worker; the pid is gone', e2e, async () =>
{
  const modelsDir = await tempDir('coral-worker-e2e-models-')
  await writeCheckpoint(modelsDir, 'gemma4-demo')
  const { worker } = await connectRealWorker({
    fake: { chunks: [{ content: 'ok' }] },
    modelsDir,
  })
  await worker.ensure()
  const pid = worker.pid()
  assert.ok(pid)
  const descendants = childPids(pid)
  await worker.dispose()
  await waitFor(
    () =>
      !processAlive(pid) && descendants.every((child) => !processAlive(child)),
    5_000,
    'worker pid to exit after dispose'
  )
})

test(
  'malformed stdin frame does not kill the worker process',
  e2e,
  async () =>
  {
    const modelsDir = await tempDir('coral-worker-e2e-models-')
    await writeCheckpoint(modelsDir, 'gemma4-demo')
    const { client, worker } = await connectRealWorker({
      fake: { chunks: [{ content: 'ok' }] },
      modelsDir,
    })
    try
    {
      await worker.ensure()
      const pid = worker.pid()
      await worker.writeRaw('not-json')
      const models = await client.listModels()
      assert.equal(models[0]?.name, 'mlx:gemma4-demo')
      assert.equal(worker.pid(), pid)
      assert.ok(pid && processAlive(pid))
    }
    finally
    {
      await worker.dispose()
    }
  }
)

test('missing mlx checkpoint names CORAL_MLX_MODELS_DIR', e2e, async () =>
{
  const modelsDir = await tempDir('coral-worker-e2e-models-')
  const { client, worker } = await connectRealWorker({
    fake: { chunks: [{ content: 'ok' }] },
    modelsDir,
  })
  try
  {
    await assert.rejects(
      () => client.showModel('mlx:not-downloaded'),
      /CORAL_MLX_MODELS_DIR/
    )
    const models = await client.listModels()
    assert.equal(models.length, 0)
  }
  finally
  {
    await worker.dispose()
  }
})

test(
  'real worker embed round-trip uses the fake embedding seam',
  e2e,
  async () =>
  {
    const modelsDir = await tempDir('coral-worker-e2e-embed-')
    await writeCheckpoint(modelsDir, 'embed-demo')
    const { worker } = await connectRealWorker({
      fake: {
        chunks: [{ content: 'ok' }],
        embed: { dimensions: 4 },
      },
      modelsDir,
    })
    try
    {
      await worker.ensure()
      const shown = await worker.request('model.show', { name: 'embed-demo' })
      assert.match(String(shown.digest ?? ''), /^[a-f0-9]{64}$/)
      const embedder = new PythonEmbedder(
        worker,
        createMlxEmbeddingSpace({
          endpointIdentity: modelsDir,
          artifactDigest: String(shown.digest),
          displayModel: 'embed-demo',
        })
      )
      const vectors = await embedder.embed(['alpha', 'beta'])
      assert.equal(vectors.length, 2)
      assert.equal(vectors[0]?.length, 4)
      assert.equal(vectors[1]?.length, 4)
      assert.deepEqual(await embedder.embed(['alpha', 'beta']), vectors)
    }
    finally
    {
      await worker.dispose()
    }
  }
)
