// tests/inference/python-embedder.test.ts
// python embedder digest fail-closed before and after embed

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { PythonEmbedder } from '../../src/inference/python-embedder.js'
import { WorkerSupervisor } from '../../src/inference/worker-supervisor.js'
import { createMlxEmbeddingSpace } from '../../src/retrieval/embedding-space.js'
import {
  DEFAULT_HANDSHAKE,
  FakeWorkerTransport,
} from '../helpers/fake-worker.js'

const DIGEST = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

function space()
{
  return createMlxEmbeddingSpace({
    endpointIdentity: '/tmp/mlx-models',
    artifactDigest: DIGEST,
    displayModel: 'embed-demo',
  })
}

function connect(transport: FakeWorkerTransport)
{
  const worker = new WorkerSupervisor({
    transportFactory: () => transport,
    closeDelayMs: 5,
    handshakeTimeoutMs: 1_000,
  })
  return { worker, embedder: new PythonEmbedder(worker, space()) }
}

test('PythonEmbedder returns worker vectors when the digest is stable', async () =>
{
  const transport = new FakeWorkerTransport({
    show: { contextLength: 8192, digest: DIGEST },
    embed: {
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    },
  })
  const { worker, embedder } = connect(transport)
  try
  {
    const vectors = await embedder.embed(['alpha', 'beta'])
    assert.deepEqual(vectors, [
      [0.1, 0.2],
      [0.3, 0.4],
    ])
    const methods = transport.written.map((frame) => frame.method)
    assert.ok(methods.includes('model.show'))
    assert.ok(methods.includes('embed'))
  }
  finally
  {
    await worker.dispose()
  }
})

test('PythonEmbedder fails closed when the digest changes before embed', async () =>
{
  const transport = new FakeWorkerTransport({
    show: { contextLength: 8192, digest: OTHER },
  })
  const { worker, embedder } = connect(transport)
  try
  {
    await assert.rejects(
      () => embedder.embed(['alpha']),
      /changed artifact identity/
    )
    assert.equal(
      transport.written.some((frame) => frame.method === 'embed'),
      false
    )
  }
  finally
  {
    await worker.dispose()
  }
})

test('PythonEmbedder fails closed when the digest changes after embed', async () =>
{
  const transport = new FakeWorkerTransport({
    showTurns: [
      { contextLength: 8192, digest: DIGEST },
      { contextLength: 8192, digest: OTHER },
    ],
    embed: { vectors: [[1, 0]] },
  })
  const { worker, embedder } = connect(transport)
  try
  {
    await assert.rejects(
      () => embedder.embed(['alpha']),
      /changed artifact identity/
    )
    assert.equal(
      transport.written.some((frame) => frame.method === 'embed'),
      true
    )
  }
  finally
  {
    await worker.dispose()
  }
})

test('PythonEmbedder refuses embed when the handshake omitted it', async () =>
{
  const transport = new FakeWorkerTransport({
    handshake: {
      ...DEFAULT_HANDSHAKE,
      methods: ['chat.start', 'model.list', 'model.show'],
    },
    show: { contextLength: 8192, digest: DIGEST },
  })
  const { worker, embedder } = connect(transport)
  try
  {
    await assert.rejects(
      () => embedder.embed(['alpha']),
      /did not advertise embed/
    )
  }
  finally
  {
    await worker.dispose()
  }
})
