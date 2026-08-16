// tests/inference/python-client.test.ts
// map protocol frames, ns durations, index, and cancel through the worker client

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Agent } from '../../src/agent/agent.js'
import { parseModelRef } from '../../src/inference/model-ref.js'
import { PythonInferenceClient } from '../../src/inference/python-client.js'
import { WorkerSupervisor } from '../../src/inference/worker-supervisor.js'
import type { ChatResponse } from '../../src/types/inference.js'
import type { Tool } from '../../src/tools/tool.js'
import { makeAgentEvents } from '../helpers/agent-harness.js'
import { FakeWorkerTransport } from '../helpers/fake-worker.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()
const MLX = parseModelRef('mlx:qwen3-coder')

function connect(transport: FakeWorkerTransport): {
  client: PythonInferenceClient
  worker: WorkerSupervisor
}
{
  const worker = new WorkerSupervisor({
    transportFactory: () => transport,
    closeDelayMs: 5,
    handshakeTimeoutMs: 1_000,
  })
  return { client: new PythonInferenceClient(worker, MLX), worker }
}

test('listModels canonicalizes mlx names and showModel returns worker info', async () =>
{
  const transport = new FakeWorkerTransport({
    models: [
      {
        name: 'qwen3-coder',
        size: 4_000_000_000,
        modified_at: '2026-08-14T00:00:00.000Z',
      },
    ],
    show: {
      contextLength: 131072,
      architecture: 'gemma4',
      size: 4_000_000_000,
      digest: 'a'.repeat(64),
    },
  })
  const { client, worker } = connect(transport)
  const models = await client.listModels()
  assert.equal(models[0]?.name, 'mlx:qwen3-coder')
  assert.equal(models[0]?.size, 4_000_000_000)
  const info = await client.showModel('mlx:qwen3-coder')
  assert.equal(info.contextLength, 131072)
  assert.equal(info.architecture, 'gemma4')
  assert.equal(info.size, 4_000_000_000)
  assert.equal(info.digest, 'a'.repeat(64))
  const showRequest = transport.written.find(
    (frame) => frame.method === 'model.show'
  )
  assert.deepEqual(showRequest?.payload, { name: 'qwen3-coder' })
  client.startKeepAlive('mlx:qwen3-coder')
  assert.equal(client.recordedKeepAliveModel(), 'qwen3-coder')
  await worker.dispose()
})

test('chatStream preserves function.index and nanosecond durations', async () =>
{
  const transport = new FakeWorkerTransport({
    chatTurns: [
      [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                type: 'function',
                function: {
                  index: 0,
                  name: 'grep',
                  arguments: { pattern: 'hel' },
                },
              },
            ],
          },
          done: false,
        },
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                type: 'function',
                function: {
                  index: 0,
                  name: 'grep',
                  arguments: { pattern: 'hello' },
                },
              },
            ],
          },
          done: false,
        },
        {
          message: { role: 'assistant', content: '' },
          done: true,
          prompt_eval_count: 12,
          prompt_eval_duration: 1_000_000_000,
          eval_count: 8,
          eval_duration: 2_000_000_000,
        },
      ],
    ],
  })
  const { client, worker } = connect(transport)
  const chunks: ChatResponse[] = []
  for await (const chunk of client.chatStream({
    model: 'mlx:qwen3-coder',
    messages: [{ role: 'user', content: 'find hello' }],
  }))
  {
    chunks.push(chunk)
  }
  assert.equal(chunks[0]?.message.tool_calls?.[0]?.function.index, 0)
  assert.equal(chunks[1]?.message.tool_calls?.[0]?.function.index, 0)
  assert.deepEqual(chunks[1]?.message.tool_calls?.[0]?.function.arguments, {
    pattern: 'hello',
  })
  const done = chunks.at(-1)
  assert.equal(done?.done, true)
  assert.equal(done?.prompt_eval_duration, 1_000_000_000)
  assert.equal(done?.eval_duration, 2_000_000_000)
  await worker.dispose()
})

test('aborting chatStream writes a cancel frame', async () =>
{
  const transport = new FakeWorkerTransport({ holdChatUntilCancel: true })
  const { client, worker } = connect(transport)
  const controller = new AbortController()
  const pending = client.chatStream(
    {
      model: 'mlx:qwen3-coder',
      messages: [{ role: 'user', content: 'hi' }],
    },
    controller.signal
  )
  const consume = (async () =>
  {
    for await (const chunk of pending)
    {
      void chunk
    }
  })()

  await new Promise<void>((resolve) =>
  {
    const timer = setInterval(() =>
    {
      if (transport.written.some((frame) => frame.method === 'chat.start'))
      {
        clearInterval(timer)
        resolve()
      }
    }, 5)
  })
  controller.abort()
  await assert.rejects(consume, { name: 'AbortError' })
  assert.equal(
    transport.written.some((frame) => frame.kind === 'cancel'),
    true
  )
  await worker.dispose()
})

test('Agent replaces streaming tool calls by function.index from the worker', async () =>
{
  const dir = await tempDir('coral-python-index-merge-')
  const transport = new FakeWorkerTransport({
    chatTurns: [
      [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                type: 'function',
                function: {
                  index: 0,
                  name: 'echo_tool',
                  arguments: { q: 'hel' },
                },
              },
            ],
          },
          done: false,
        },
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                type: 'function',
                function: {
                  index: 0,
                  name: 'echo_tool',
                  arguments: { q: 'hello' },
                },
              },
            ],
          },
          done: false,
        },
        {
          message: { role: 'assistant', content: '' },
          done: true,
          eval_count: 8,
          eval_duration: 2_000_000_000,
        },
      ],
      [
        {
          message: { role: 'assistant', content: 'done' },
          done: true,
        },
      ],
    ],
  })
  const { client, worker } = connect(transport)
  const seen: unknown[] = []
  const echoTool: Tool = {
    name: 'echo_tool',
    description: 'echo arguments',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    },
    async execute(args)
    {
      seen.push(args)
      return { output: 'ok' }
    },
  }
  const agent = new Agent('mlx:qwen3-coder', 'http://localhost:11434', dir, {
    inferenceClient: client,
    tools: [echoTool],
    numCtx: 8_192,
  })
  await agent.run('find hello', makeAgentEvents())
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], { q: 'hello' })
  await agent.dispose()
  await worker.dispose()
})
