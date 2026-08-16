// tests/inference/worker-supervisor.test.ts
// worker handshake, restart, cancellation, and recycle invariants

import { strict as assert } from 'node:assert'
import { chmod, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  resolveWorkerLaunch,
  WorkerSupervisor,
} from '../../src/inference/worker-supervisor.js'
import {
  DEFAULT_HANDSHAKE,
  FakeWorkerTransport,
} from '../helpers/fake-worker.js'
import { makeTempDirPool } from '../helpers/temp.js'

const { tempDir } = makeTempDirPool()

function supervisor(transport: FakeWorkerTransport): WorkerSupervisor
{
  return new WorkerSupervisor({
    transportFactory: () => transport,
    closeDelayMs: 5,
    handshakeTimeoutMs: 1_000,
  })
}

class CloseTrackingTransport extends FakeWorkerTransport
{
  closeCount = 0

  override async close(): Promise<void>
  {
    this.closeCount += 1
    await super.close()
  }
}

class DeferredHandshakeTransport extends FakeWorkerTransport
{
  private handshakeLine?: string

  override write(line: string): Promise<void>
  {
    const frame = JSON.parse(line) as Record<string, unknown>
    if (frame.kind === 'request' && frame.method === 'handshake')
    {
      this.handshakeLine = line
      return Promise.resolve()
    }
    return super.write(line)
  }

  releaseHandshake(): void
  {
    if (!this.handshakeLine) throw new Error('handshake was not requested')
    void super.write(this.handshakeLine)
  }
}

class EventThenHoldTransport extends CloseTrackingTransport
{
  cancelAttempts = 0

  override write(line: string): Promise<void>
  {
    const frame = JSON.parse(line) as Record<string, unknown>
    if (frame.kind === 'request' && frame.method === 'chat.start')
    {
      this.written.push(frame)
      queueMicrotask(() =>
      {
        this.emit({
          v: 1,
          id: String(frame.id),
          kind: 'event',
          method: 'chat.start',
          payload: {
            message: { role: 'assistant', content: 'partial' },
            done: false,
          },
        })
      })
      return Promise.resolve()
    }
    if (frame.kind === 'cancel')
    {
      this.written.push(frame)
      this.cancelAttempts += 1
      queueMicrotask(() =>
      {
        this.emit({
          v: 1,
          id: String(frame.id),
          kind: 'result',
          method: 'chat.start',
          payload: { cancelled: true },
        })
      })
      return Promise.reject(new Error('transport already closed'))
    }
    return super.write(line)
  }
}

class StalledRequestTransport extends FakeWorkerTransport
{
  readonly requestSeen: Promise<void>
  cancelAttempts = 0
  private markRequestSeen!: () => void
  private rejectRequest?: (error: Error) => void

  constructor()
  {
    super()
    this.requestSeen = new Promise((resolveRequestSeen) =>
    {
      this.markRequestSeen = resolveRequestSeen
    })
  }

  override write(line: string): Promise<void>
  {
    const frame = JSON.parse(line) as Record<string, unknown>
    if (frame.kind === 'request' && frame.method === 'chat.start')
    {
      this.written.push(frame)
      this.markRequestSeen()
      return new Promise((_, rejectRequest) =>
      {
        this.rejectRequest = rejectRequest
      })
    }
    if (frame.kind === 'cancel')
    {
      this.written.push(frame)
      this.cancelAttempts += 1
      const rejectRequest = this.rejectRequest
      this.rejectRequest = undefined
      rejectRequest?.(new Error('stalled request write closed'))
      return Promise.reject(new Error('cancel write closed'))
    }
    return super.write(line)
  }
}

class OpaqueEmbedTransport extends CloseTrackingTransport
{
  readonly embedSeen: Promise<void>
  readonly unrelatedSeen: Promise<void>
  cancelAttempts = 0
  private markEmbedSeen!: () => void
  private markUnrelatedSeen!: () => void
  private unrelated?: Record<string, unknown>

  constructor()
  {
    super()
    this.embedSeen = new Promise((resolveEmbedSeen) =>
    {
      this.markEmbedSeen = resolveEmbedSeen
    })
    this.unrelatedSeen = new Promise((resolveUnrelatedSeen) =>
    {
      this.markUnrelatedSeen = resolveUnrelatedSeen
    })
  }

  override write(line: string): Promise<void>
  {
    const frame = JSON.parse(line) as Record<string, unknown>
    if (frame.kind === 'request' && frame.method === 'embed')
    {
      this.written.push(frame)
      this.markEmbedSeen()
      return Promise.resolve()
    }
    if (frame.kind === 'request' && frame.method === 'model.show')
    {
      this.written.push(frame)
      this.unrelated = frame
      this.markUnrelatedSeen()
      return Promise.resolve()
    }
    if (frame.kind === 'cancel')
    {
      this.written.push(frame)
      this.cancelAttempts += 1
      return Promise.resolve()
    }
    return super.write(line)
  }

  releaseUnrelated(): void
  {
    const frame = this.unrelated
    if (!frame) return
    this.unrelated = undefined
    this.emit({
      v: 1,
      id: String(frame.id),
      kind: 'result',
      method: 'model.show',
      payload: { contextLength: 8_192 },
    })
  }
}

class OpaqueChatTransport extends CloseTrackingTransport
{
  readonly chatSeen: Promise<void>
  cancelAttempts = 0
  private markChatSeen!: () => void

  constructor()
  {
    super()
    this.chatSeen = new Promise((resolveChatSeen) =>
    {
      this.markChatSeen = resolveChatSeen
    })
  }

  override write(line: string): Promise<void>
  {
    const frame = JSON.parse(line) as Record<string, unknown>
    if (frame.kind === 'request' && frame.method === 'chat.start')
    {
      this.written.push(frame)
      this.markChatSeen()
      return Promise.resolve()
    }
    if (frame.kind === 'cancel')
    {
      this.written.push(frame)
      this.cancelAttempts += 1
      return Promise.resolve()
    }
    return super.write(line)
  }
}

test('handshake fails closed when required methods are missing', async () =>
{
  const transport = new FakeWorkerTransport({
    handshake: {
      ...DEFAULT_HANDSHAKE,
      methods: ['chat.start'],
    },
  })
  const worker = supervisor(transport)
  await assert.rejects(
    () => worker.ensure(),
    /missing required methods: model\.list, model\.show/
  )
  await worker.dispose()
})

test('handshake fails closed on protocolVersion mismatch', async () =>
{
  const transport = new FakeWorkerTransport({
    handshake: {
      ...DEFAULT_HANDSHAKE,
      protocolVersion: 2,
    },
  })
  const worker = supervisor(transport)
  await assert.rejects(() => worker.ensure(), /protocolVersion 2/)
  await worker.dispose()
})

test('handshake fails closed when the result is not a handshake payload', async () =>
{
  const transport = new FakeWorkerTransport({
    handshake: { ok: true },
  })
  const worker = supervisor(transport)
  await assert.rejects(() => worker.ensure(), /not a handshake payload/)
  await worker.dispose()
})

test('failed handshakes close each exact transport before retry', async () =>
{
  const transports: CloseTrackingTransport[] = []
  const worker = new WorkerSupervisor({
    closeDelayMs: 5,
    handshakeTimeoutMs: 1_000,
    transportFactory: () =>
    {
      const transport = new CloseTrackingTransport({
        handshake: { ...DEFAULT_HANDSHAKE, protocolVersion: 2 },
      })
      transports.push(transport)
      return transport
    },
  })

  await assert.rejects(() => worker.ensure(), /protocolVersion 2/)
  await assert.rejects(() => worker.ensure(), /protocolVersion 2/)
  assert.deepEqual(
    transports.map((transport) => transport.closeCount),
    [1, 1]
  )
  await worker.dispose()
})

test('one caller can abort without cancelling shared worker startup', async () =>
{
  const transport = new DeferredHandshakeTransport()
  const worker = supervisor(transport)
  const controller = new AbortController()
  const first = worker.ensure(controller.signal)
  const second = worker.ensure()

  controller.abort()
  await assert.rejects(first, { name: 'AbortError' })
  transport.releaseHandshake()
  await second
  assert.equal(worker.handshakeResult()?.protocolVersion, 1)
  await worker.dispose()
})

test('closing a stream early keeps a cooperatively cancelled worker', async () =>
{
  const transport = new EventThenHoldTransport()
  const worker = supervisor(transport)
  const stream = worker.stream('chat.start', {})

  const first = await stream.next()
  assert.equal(first.value?.kind, 'event')
  await stream.return(undefined)
  const models = await worker.request('model.list', {})

  assert.equal(transport.cancelAttempts, 1)
  assert.ok(Array.isArray(models.models))
  assert.equal(transport.closeCount, 0)
  await worker.dispose()
})

test('abort interrupts a stalled initial stream write and consumes failures', async () =>
{
  const transport = new StalledRequestTransport()
  const worker = supervisor(transport)
  const controller = new AbortController()
  const stream = worker.stream('chat.start', {}, controller.signal)
  const rejected = assert.rejects(stream.next(), { name: 'AbortError' })

  await transport.requestSeen
  controller.abort()
  let timeout: NodeJS.Timeout | undefined
  try
  {
    await Promise.race([
      rejected,
      new Promise<never>((_, rejectTimeout) =>
      {
        timeout = setTimeout(
          () => rejectTimeout(new Error('stream abort timed out')),
          1_000
        )
      }),
    ])
  }
  finally
  {
    if (timeout) clearTimeout(timeout)
  }
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))

  assert.equal(transport.cancelAttempts, 1)
  await worker.dispose()
})

test('aborted opaque work recycles after unrelated requests drain', async () =>
{
  const transports: CloseTrackingTransport[] = []
  const opaque = new OpaqueEmbedTransport()
  const opaqueChat = new OpaqueChatTransport()
  const worker = new WorkerSupervisor({
    closeDelayMs: 5,
    handshakeTimeoutMs: 1_000,
    transportFactory: () =>
    {
      let transport: CloseTrackingTransport
      if (transports.length === 0) transport = opaque
      else if (transports.length === 1) transport = opaqueChat
      else transport = new CloseTrackingTransport()
      transports.push(transport)
      return transport
    },
  })
  const controller = new AbortController()
  let unrelated: Promise<Record<string, unknown>> | undefined
  let next: Promise<Record<string, unknown>> | undefined

  try
  {
    const embed = worker.request(
      'embed',
      { model: 'embed-demo', texts: ['slow'] },
      controller.signal
    )
    await opaque.embedSeen
    unrelated = worker.request('model.show', { name: 'chat-demo' })
    void unrelated.catch(() => undefined)
    await opaque.unrelatedSeen

    controller.abort()
    await assert.rejects(embed, { name: 'AbortError' })
    next = worker.request('model.list', {})
    let nextSettled = false
    void next.then(
      () =>
      {
        nextSettled = true
      },
      () =>
      {
        nextSettled = true
      }
    )
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 300))

    assert.equal(opaque.cancelAttempts, 1)
    assert.equal(opaque.closeCount, 0)
    assert.equal(nextSettled, false)

    opaque.releaseUnrelated()
    assert.deepEqual(await unrelated, { contextLength: 8_192 })
    const nextResult = await Promise.race([
      next,
      new Promise<never>((_, rejectTimeout) =>
      {
        setTimeout(
          () => rejectTimeout(new Error('recycled request timed out')),
          1_000
        ).unref()
      }),
    ])
    assert.ok(Array.isArray(nextResult.models))
    assert.equal(opaque.closeCount, 1)
    assert.equal(transports.length, 2)

    const chatController = new AbortController()
    const chat = worker.stream('chat.start', {}, chatController.signal)
    const chatNext = chat.next()
    await opaqueChat.chatSeen
    chatController.abort()
    await assert.rejects(chatNext, { name: 'AbortError' })
    const afterChat = await worker.request('model.list', {})
    assert.ok(Array.isArray(afterChat.models))
    assert.equal(opaqueChat.cancelAttempts, 1)
    assert.equal(opaqueChat.closeCount, 1)
    assert.equal(transports.length, 3)

    transports[2]!.crash()
    await worker.ensure()
    assert.equal(transports.length, 4)
  }
  finally
  {
    opaque.releaseUnrelated()
    await worker.dispose()
    await Promise.allSettled([unrelated, next].filter(Boolean))
  }
})

test('supervisor restarts once after a crash, then stays dead', async () =>
{
  const transports: FakeWorkerTransport[] = []
  const worker = new WorkerSupervisor({
    closeDelayMs: 5,
    handshakeTimeoutMs: 1_000,
    transportFactory: () =>
    {
      const transport = new FakeWorkerTransport()
      transports.push(transport)
      return transport
    },
  })

  await worker.ensure()
  assert.equal(transports.length, 1)
  transports[0]!.crash()
  await worker.ensure()
  assert.equal(transports.length, 2)
  transports[1]!.crash()
  await assert.rejects(() => worker.ensure(), /crashed again after one restart/)
  assert.equal(transports.length, 2)
  await worker.dispose()
})

test('a failed background restart closes and leaves a stable dead error', async () =>
{
  const transports: CloseTrackingTransport[] = []
  const worker = new WorkerSupervisor({
    closeDelayMs: 5,
    handshakeTimeoutMs: 1_000,
    transportFactory: () =>
    {
      const transport = new CloseTrackingTransport({
        handshake:
          transports.length === 0
            ? DEFAULT_HANDSHAKE
            : { ...DEFAULT_HANDSHAKE, protocolVersion: 2 },
      })
      transports.push(transport)
      return transport
    },
  })

  await worker.ensure()
  transports[0]!.crash()
  await assert.rejects(() => worker.ensure(), /protocolVersion 2/)
  await assert.rejects(() => worker.ensure(), /protocolVersion 2/)
  assert.equal(transports.length, 2)
  assert.equal(transports[1]!.closeCount, 1)
  await worker.dispose()
})

test('missing worker package is an install error, not a spawn', async () =>
{
  const dir = await tempDir('coral-worker-missing-')
  const launch = resolveWorkerLaunch(dir)
  assert.equal('error' in launch, true)
  if ('error' in launch)
  {
    assert.match(launch.error, /uv sync --project packages\/coral-backend/)
    assert.match(
      launch.error,
      /uv run --project packages\/coral-backend python -m coral_backend/
    )
  }
})

test('worker launch passes an absolute MLX models directory', async () =>
{
  const dir = await tempDir('coral-worker-launch-')
  const launch = resolveWorkerLaunch(dir, {
    CORAL_PYTHON: process.execPath,
    CORAL_MLX_MODELS_DIR: 'relative-models',
  })
  assert.equal('error' in launch, false)
  if (!('error' in launch))
  {
    assert.equal(launch.env.CORAL_MLX_MODELS_DIR, resolve('relative-models'))
  }
})

test(
  'real transport rejects a backpressured write when worker stdin closes',
  { skip: process.platform === 'win32' },
  async () =>
  {
    const dir = await tempDir('coral-worker-backpressure-')
    const script = resolve(dir, 'worker-stops-reading')
    await writeFile(
      script,
      `#!/usr/bin/env node
let input = ''
const keepAlive = setInterval(() => {}, 1_000)
process.stdin.setEncoding('utf8')
process.stdin.on('data', function onData(chunk) {
  input += chunk
  const newline = input.indexOf('\\n')
  if (newline < 0) return
  const request = JSON.parse(input.slice(0, newline))
  process.stdout.write(JSON.stringify({
    v: 1,
    id: request.id,
    kind: 'result',
    method: 'handshake',
    payload: {
      protocolVersion: 1,
      methods: ['chat.start', 'model.list', 'model.show'],
      versions: { python: 'test' }
    }
  }) + '\\n')
  process.stdin.removeListener('data', onData)
  process.stdin.pause()
})
process.on('SIGTERM', () => {
  clearInterval(keepAlive)
  process.exit(0)
})
`,
      'utf8'
    )
    await chmod(script, 0o755)
    const worker = new WorkerSupervisor({
      repoRoot: dir,
      extraEnv: { CORAL_PYTHON: script },
      closeDelayMs: 50,
      handshakeTimeoutMs: 1_000,
    })

    try
    {
      await worker.ensure()
      const pid = worker.pid()
      assert.ok(pid)
      const pending = worker.writeRaw('x'.repeat(8 * 1024 * 1024))
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
      process.kill(pid, 'SIGKILL')
      const outcome = await Promise.race([
        pending.then(
          () => 'resolved' as const,
          () => 'rejected' as const
        ),
        new Promise<'timeout'>((resolveTimeout) =>
        {
          setTimeout(() => resolveTimeout('timeout'), 1_000).unref()
        }),
      ])
      assert.equal(outcome, 'rejected')
    }
    finally
    {
      await worker.dispose()
    }
  }
)

test('spawn failure is an install error naming the uv sync command', async () =>
{
  const worker = new WorkerSupervisor({
    extraEnv: { CORAL_PYTHON: '/nonexistent/coral-python-missing' },
    closeDelayMs: 5,
    handshakeTimeoutMs: 1_000,
  })
  await assert.rejects(
    () => worker.ensure(),
    /uv sync --project packages\/coral-backend/
  )
  await worker.dispose()
})
