// tests/helpers/fake-worker.ts
// in-memory worker stdio transport for Phase 2 inference tests

import type { Envelope } from '../../src/protocol/generated/types.js'
import type { WorkerStdioTransport } from '../../src/inference/worker-supervisor.js'

export const DEFAULT_HANDSHAKE = {
  protocolVersion: 1,
  methods: ['chat.start', 'model.list', 'model.show', 'embed'],
  versions: {
    python: '3.14.0',
    mlx: '0.32.0',
    mlx_lm: '0.31.3',
  },
}

export const DEFAULT_SHOW = {
  contextLength: 8192,
  architecture: 'gemma4',
}

export interface FakeListedModel
{
  name: string
  size: number
  modified_at: string
  model?: string
  digest?: string
}

export interface FakeEmbedScript
{
  vectors?: number[][]
  dimensions?: number
}

export interface FakeWorkerOptions
{
  handshake?: Record<string, unknown>
  models?: FakeListedModel[]
  show?: Record<string, unknown>
  showTurns?: Array<Record<string, unknown>>
  embed?: FakeEmbedScript
  chatTurns?: Array<Array<Record<string, unknown>>>
  holdChatUntilCancel?: boolean
}

export function workerFrame(
  kind: 'event' | 'result' | 'error',
  id: string,
  method: string,
  payload: Record<string, unknown>
): Envelope
{
  if (kind === 'error')
  {
    return { v: 1, id, kind, method, payload }
  }
  return { v: 1, id, kind, method, payload }
}

// in-memory NDJSON worker used by PythonInferenceClient tests
export class FakeWorkerTransport implements WorkerStdioTransport
{
  readonly written: Array<Record<string, unknown>> = []
  readonly cancelled = new Set<string>()
  private lineHandler?: (line: string) => void
  private exitHandler?: (
    code: number | null,
    signal: NodeJS.Signals | null
  ) => void
  private chatTurn = 0
  private showTurn = 0
  private readonly pendingChat = new Map<string, () => void>()

  constructor(private readonly options: FakeWorkerOptions = {})
  {}

  async start(): Promise<void>
  {}

  write(line: string): Promise<void>
  {
    const parsed = JSON.parse(line) as Record<string, unknown>
    this.written.push(parsed)
    if (parsed.kind === 'cancel' && typeof parsed.id === 'string')
    {
      this.cancelled.add(parsed.id)
      this.pendingChat.get(parsed.id)?.()
      return Promise.resolve()
    }
    if (parsed.kind !== 'request' || typeof parsed.id !== 'string')
    {
      return Promise.resolve()
    }
    queueMicrotask(() => this.respond(parsed))
    return Promise.resolve()
  }

  onLine(handler: (line: string) => void): void
  {
    this.lineHandler = handler
  }

  onExit(
    handler: (code: number | null, signal: NodeJS.Signals | null) => void
  ): void
  {
    this.exitHandler = handler
  }

  onError(): void
  {}

  async close(): Promise<void>
  {
    for (const release of this.pendingChat.values()) release()
    this.pendingChat.clear()
  }

  crash(code = 1): void
  {
    this.exitHandler?.(code, null)
  }

  emit(envelope: Envelope): void
  {
    this.lineHandler?.(JSON.stringify(envelope))
  }

  private respond(request: Record<string, unknown>): void
  {
    const id = String(request.id)
    const method = String(request.method)

    if (method === 'handshake')
    {
      this.emit(
        workerFrame(
          'result',
          id,
          method,
          this.options.handshake ?? DEFAULT_HANDSHAKE
        )
      )
      return
    }

    if (method === 'model.list')
    {
      this.emit(
        workerFrame('result', id, method, {
          models: this.options.models ?? [
            {
              name: 'qwen3-coder',
              size: 4_000_000_000,
              modified_at: '2026-08-14T00:00:00.000Z',
            },
          ],
        })
      )
      return
    }

    if (method === 'model.show')
    {
      const fromTurns = this.options.showTurns?.[this.showTurn]
      if (fromTurns) this.showTurn += 1
      this.emit(
        workerFrame(
          'result',
          id,
          method,
          fromTurns ?? this.options.show ?? DEFAULT_SHOW
        )
      )
      return
    }

    if (method === 'embed')
    {
      const payload =
        request.payload && typeof request.payload === 'object'
          ? (request.payload as Record<string, unknown>)
          : {}
      const texts = Array.isArray(payload.texts) ? payload.texts : []
      const configured = this.options.embed
      const vectors =
        configured?.vectors ??
        texts.map((_, index) =>
        {
          const dims = configured?.dimensions ?? 4
          return Array.from(
            { length: dims },
            (__, dim) => (index + 1) * 0.1 + dim * 0.01
          )
        })
      this.emit(workerFrame('result', id, method, { vectors }))
      return
    }

    if (method === 'chat.start')
    {
      if (this.options.holdChatUntilCancel)
      {
        this.pendingChat.set(id, () =>
        {
          this.pendingChat.delete(id)
        })
        return
      }
      const turns = this.options.chatTurns
      const chunks =
        turns?.[this.chatTurn] ??
        ([
          {
            message: { role: 'assistant', content: 'ok' },
            done: true,
            prompt_eval_count: 12,
            prompt_eval_duration: 1_000_000_000,
            eval_count: 4,
            eval_duration: 2_000_000_000,
          },
        ] as Array<Record<string, unknown>>)
      this.chatTurn += 1
      for (const chunk of chunks)
      {
        if (this.cancelled.has(id)) return
        this.emit(workerFrame('event', id, method, chunk))
      }
      this.emit(workerFrame('result', id, method, { status: 'ok' }))
      return
    }

    this.emit(
      workerFrame('error', id, method, {
        message: `unexpected method ${method}`,
      })
    )
  }
}
