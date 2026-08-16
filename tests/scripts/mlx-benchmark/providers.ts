// tests/scripts/mlx-benchmark/providers.ts
// benchmark-only Ollama, stock MLX server, and immutable candidate runtimes

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { AgentInferenceClient } from '../../../src/agent/inference-client.js'
import type {
  ChatRequest,
  ChatResponse,
  Model,
  ModelInfo,
  ModelRequestMessage,
  OllamaToolCall,
} from '../../../src/types/inference.js'
import { PinnedOllamaClient } from './ollama.js'
import {
  assertBrowserOriginDenied,
  OwnedChild,
  randomLoopbackPort,
  waitForHttp,
  waitForPidsToExit,
} from './process.js'
import type {
  BenchmarkConfig,
  BenchmarkTopologyConfig,
  CustomMlxTopologyConfig,
  MlxAllocatorMetrics,
  ModelPair,
  StockMlxTopologyConfig,
  TopologyIdentity,
} from './types.js'

const execFileAsync = promisify(execFile)
const MAX_ERROR_BYTES = 64 * 1024

export interface BenchmarkRuntime
{
  readonly identity: TopologyIdentity
  start(initialPair: ModelPair): Promise<void>
  client(pair: ModelPair): Promise<AgentInferenceClient>
  model(pair: ModelPair): string
  processRoots(): number[]
  resetModel(pair: ModelPair): Promise<void>
  crashAndRestart(pair: ModelPair): Promise<void>
  allocatorMemory(reset?: boolean): Promise<MlxAllocatorMetrics | undefined>
  stop(): Promise<{ descendants: number[]; allExited: boolean }>
}

function topologyIdentity(config: BenchmarkTopologyConfig): TopologyIdentity
{
  return {
    id: config.id,
    kind: config.kind,
    role: config.role,
    description: config.description,
    immutableRevision:
      config.kind === 'custom-mlx'
        ? config.expectedRevision
        : config.kind === 'stock-mlx'
          ? 'recorded-in-software-identity'
          : 'external-ollama-service',
    ...(config.requiredCapability
      ? { requiredCapability: config.requiredCapability }
      : {}),
    ...(config.kind === 'stock-mlx' ? { launchPorts: [] } : {}),
  }
}

function modelInfo(pair: ModelPair): ModelInfo
{
  return {
    contextLength: pair.mlx.contextWindow,
    architecture: pair.id.toLowerCase().includes('qwen')
      ? 'qwen3_5'
      : undefined,
  }
}

function listedModels(pairs: ModelPair[]): Model[]
{
  return pairs.map((pair) => ({
    name: pair.mlx.model,
    model: pair.mlx.model,
    size: 0,
    modified_at: '',
  }))
}

function wireMessages(messages: ModelRequestMessage[]): unknown[]
{
  let nextCallId = 0
  const callIds: string[] = []
  let consumedResults = 0
  return messages.map((message) =>
  {
    const wired: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    }
    if (message.thinking) wired.reasoning = message.thinking
    if (message.tool_calls)
    {
      wired.tool_calls = message.tool_calls.map((call) =>
      {
        const id = `call_${nextCallId++}`
        callIds.push(id)
        return {
          id,
          type: 'function',
          function: {
            name: call.function.name,
            arguments: JSON.stringify(call.function.arguments),
          },
        }
      })
    }
    if (message.role === 'tool')
    {
      wired.name = message.tool_name
      wired.tool_name = message.tool_name
      wired.tool_call_id =
        callIds[consumedResults++] ?? `call_${consumedResults}`
    }
    return wired
  })
}

function parseArguments(value: unknown): Record<string, unknown>
{
  if (typeof value === 'object' && value !== null)
  {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') return {}
  try
  {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  }
  catch
  {
    return {}
  }
}

function finiteNumber(value: unknown): number | undefined
{
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined
{
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

export function stockChunk(value: unknown): ChatResponse | undefined
{
  const frame = record(value)
  if (!frame) return undefined
  const choices = Array.isArray(frame.choices) ? frame.choices : []
  const first = record(choices[0])
  const delta = record(first?.delta)
  const usage = record(frame.usage)
  const toolCalls: OllamaToolCall[] = []
  const rawCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : []
  for (const rawCall of rawCalls)
  {
    const call = record(rawCall)
    const fn = record(call?.function)
    if (typeof fn?.name !== 'string') continue
    toolCalls.push({
      type: 'function',
      function: {
        index: finiteNumber(call?.index),
        name: fn.name,
        arguments: parseArguments(fn.arguments),
      },
    })
  }
  const content = typeof delta?.content === 'string' ? delta.content : ''
  const thinking =
    typeof delta?.reasoning === 'string' ? delta.reasoning : undefined
  const done =
    first?.finish_reason !== null && first?.finish_reason !== undefined
  if (!delta && !usage && !done) return undefined
  return {
    message: {
      role: 'assistant',
      content,
      ...(thinking ? { thinking } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    done: done || Boolean(usage),
    prompt_eval_count: finiteNumber(usage?.prompt_tokens),
    eval_count: finiteNumber(usage?.completion_tokens),
  }
}

async function* sseJson(response: Response): AsyncGenerator<unknown>
{
  if (!response.body) throw new Error('stock MLX response had no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  while (true)
  {
    const { done, value } = await reader.read()
    buffered += decoder.decode(value, { stream: !done })
    let boundary = buffered.indexOf('\n\n')
    while (boundary >= 0)
    {
      const event = buffered.slice(0, boundary)
      buffered = buffered.slice(boundary + 2)
      for (const line of event.split('\n'))
      {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        yield JSON.parse(payload) as unknown
      }
      boundary = buffered.indexOf('\n\n')
    }
    if (done) break
  }
  if (buffered.trim())
  {
    throw new Error('stock MLX stream ended with a truncated SSE event')
  }
}

class StockMlxClient implements AgentInferenceClient
{
  constructor(
    private readonly baseUrl: string,
    private readonly pairs: ModelPair[],
    private readonly sampling: Pick<BenchmarkConfig, 'temperature' | 'topP'>
  )
  {}

  startKeepAlive(): void
  {}

  async showModel(model: string): Promise<ModelInfo>
  {
    const pair = this.pairs.find(
      (candidate) => candidate.mlx.localPath === model
    )
    if (!pair) throw new Error(`unconfigured stock MLX model: ${model}`)
    return modelInfo(pair)
  }

  async listModels(): Promise<Model[]>
  {
    return listedModels(this.pairs)
  }

  async allocatorMemory(reset = false): Promise<MlxAllocatorMetrics>
  {
    const response = await fetch(
      `${this.baseUrl}/benchmark/memory${reset ? '/reset' : ''}`,
      { signal: AbortSignal.timeout(2_000) }
    )
    if (!response.ok)
    {
      throw new Error(
        `stock MLX allocator endpoint returned ${response.status}`
      )
    }
    const payload = (await response.json()) as Record<string, unknown>
    const activeBytes = finiteNumber(payload.activeBytes)
    const cacheBytes = finiteNumber(payload.cacheBytes)
    const peakBytes = finiteNumber(payload.peakBytes)
    const modelIdentity =
      typeof payload.modelIdentity === 'string'
        ? payload.modelIdentity
        : undefined
    if (
      activeBytes === undefined ||
      cacheBytes === undefined ||
      peakBytes === undefined ||
      activeBytes < 0 ||
      cacheBytes < 0 ||
      peakBytes < 0
    )
    {
      throw new Error('stock MLX allocator endpoint returned invalid counters')
    }
    return {
      activeBytes,
      cacheBytes,
      peakBytes,
      ...(modelIdentity ? { modelIdentity } : {}),
    }
  }

  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatResponse>
  {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: wireMessages(request.messages),
        ...(request.tools ? { tools: request.tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
        temperature: this.sampling.temperature,
        top_p: this.sampling.topP,
        max_completion_tokens: request.num_predict ?? 512,
        chat_template_kwargs: {
          enable_thinking:
            request.think !== undefined && request.think !== false,
        },
      }),
      signal,
    })
    if (!response.ok)
    {
      const detail = (await response.text()).slice(0, MAX_ERROR_BYTES)
      throw new Error(`stock MLX HTTP ${response.status}: ${detail}`)
    }
    for await (const frame of sseJson(response))
    {
      const chunk = stockChunk(frame)
      if (chunk) yield chunk
    }
  }
}

function interpolateToken(
  value: string,
  variables: Record<string, string>
): string
{
  return value.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_whole, name) =>
  {
    const replacement = variables[name]
    if (replacement === undefined)
      throw new Error(`unknown launch token {${name}}`)
    return replacement
  })
}

class StockMlxRuntime implements BenchmarkRuntime
{
  readonly identity: TopologyIdentity
  private child?: OwnedChild
  private stockClient?: StockMlxClient

  constructor(
    private readonly config: StockMlxTopologyConfig,
    private readonly pairs: ModelPair[],
    software: BenchmarkConfig['software'],
    private readonly sampling: Pick<BenchmarkConfig, 'temperature' | 'topP'>
  )
  {
    this.identity = {
      ...topologyIdentity(config),
      immutableRevision: `mlx-lm@${software.mlxLm}+mlx@${software.mlx}`,
    }
  }

  async start(initialPair: ModelPair): Promise<void>
  {
    if (this.child) return
    if (this.config.host !== '127.0.0.1')
    {
      throw new Error('stock MLX must bind to exact loopback host 127.0.0.1')
    }
    const deadline = Date.now() + this.config.startupTimeoutMs
    let lastError = 'no launch attempted'
    for (let attempt = 1; attempt <= this.config.bindAttempts; attempt++)
    {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) break
      let port: number
      try
      {
        port = await randomLoopbackPort()
      }
      catch (error)
      {
        lastError = error instanceof Error ? error.message : String(error)
        continue
      }
      this.identity.launchPorts?.push(port)
      const variables = {
        model: initialPair.mlx.localPath,
        port: String(port),
        host: this.config.host,
        deniedBrowserOrigin: this.config.deniedBrowserOrigin,
      }
      const launch = {
        command: interpolateToken(this.config.launch.command, variables),
        args: this.config.launch.args.map((arg) =>
          interpolateToken(arg, variables)
        ),
        cwd: interpolateToken(this.config.launch.cwd, variables),
        env: Object.fromEntries(
          Object.entries(this.config.launch.env).map(([key, value]) => [
            key,
            interpolateToken(value, variables),
          ])
        ),
      }
      const child = new OwnedChild(launch)
      this.child = child
      const baseUrl = `http://${this.config.host}:${port}`
      try
      {
        await child.start()
        await waitForHttp(`${baseUrl}/health`, remainingMs, child)
      }
      catch (error)
      {
        lastError = error instanceof Error ? error.message : String(error)
        const stopped = await child.stop()
        if (this.child === child) this.child = undefined
        if (!stopped.allExited)
        {
          throw new Error(
            `stock MLX launch attempt ${attempt} left descendants: ` +
              stopped.descendants.join(', ')
          )
        }
        continue
      }
      try
      {
        await assertBrowserOriginDenied(
          `${baseUrl}/health`,
          this.config.deniedBrowserOrigin
        )
      }
      catch (error)
      {
        const stopped = await child.stop()
        if (this.child === child) this.child = undefined
        if (!stopped.allExited)
        {
          throw new Error(
            `browser-origin rejection cleanup left descendants: ${stopped.descendants.join(', ')}`
          )
        }
        throw error
      }
      this.stockClient = new StockMlxClient(baseUrl, this.pairs, this.sampling)
      return
    }
    throw new Error(
      `stock MLX exhausted ${this.config.bindAttempts} bounded random-port ` +
        `launch attempts within ${this.config.startupTimeoutMs} ms: ${lastError}`
    )
  }

  async client(): Promise<AgentInferenceClient>
  {
    if (!this.stockClient) throw new Error('stock MLX runtime is not started')
    return this.stockClient
  }

  model(pair: ModelPair): string
  {
    return pair.mlx.localPath
  }

  processRoots(): number[]
  {
    return this.child?.pid ? [this.child.pid] : []
  }

  async resetModel(pair: ModelPair): Promise<void>
  {
    await this.stop()
    await this.start(pair)
  }

  async crashAndRestart(pair: ModelPair): Promise<void>
  {
    if (!this.child) throw new Error('stock MLX runtime is not started')
    const descendants = await this.child.crash()
    this.child = undefined
    this.stockClient = undefined
    if (!(await waitForPidsToExit(descendants, 2_000)))
    {
      throw new Error(
        `crashed stock MLX left descendants: ${descendants.join(', ')}`
      )
    }
    await this.start(pair)
  }

  async allocatorMemory(reset = false): Promise<MlxAllocatorMetrics>
  {
    if (!this.stockClient) throw new Error('stock MLX runtime is not started')
    return this.stockClient.allocatorMemory(reset)
  }

  async stop(): Promise<{ descendants: number[]; allExited: boolean }>
  {
    const child = this.child
    this.child = undefined
    this.stockClient = undefined
    const result = child ? child.stop() : { descendants: [], allExited: true }
    return result
  }
}

class OllamaRuntime implements BenchmarkRuntime
{
  readonly identity: TopologyIdentity
  private readonly ollama: PinnedOllamaClient
  private roots: number[]

  constructor(
    private readonly config: Extract<
      BenchmarkTopologyConfig,
      { kind: 'ollama' }
    >,
    sampling: Pick<BenchmarkConfig, 'temperature' | 'topP'>
  )
  {
    this.identity = topologyIdentity(config)
    this.ollama = new PinnedOllamaClient(config.host, sampling)
    this.roots = [...config.processRootPids]
  }

  async start(): Promise<void>
  {
    await this.ollama.listModels()
    if (this.roots.length === 0)
    {
      const { stdout } = await execFileAsync('lsof', [
        '-nP',
        `-iTCP:${this.config.listenerPort}`,
        '-sTCP:LISTEN',
        '-t',
      ])
      this.roots = stdout
        .split('\n')
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 1)
      if (this.roots.length === 0)
      {
        throw new Error('could not identify the Ollama listener process')
      }
    }
  }

  async client(): Promise<AgentInferenceClient>
  {
    return this.ollama
  }

  model(pair: ModelPair): string
  {
    return pair.ollama.model
  }

  processRoots(): number[]
  {
    return this.roots
  }

  async resetModel(pair: ModelPair): Promise<void>
  {
    await this.ollama.evictModel(pair.ollama.model)
  }

  async crashAndRestart(): Promise<void>
  {
    throw new Error('the benchmark never crashes an external Ollama service')
  }

  async allocatorMemory(): Promise<undefined>
  {
    return undefined
  }

  async stop(): Promise<{ descendants: number[]; allExited: boolean }>
  {
    return { descendants: [], allExited: true }
  }
}

interface CandidateWorker
{
  ensure(signal?: AbortSignal): Promise<void>
  dispose(): Promise<void>
  pid(): number | undefined
}

type WorkerConstructor = new (options: {
  repoRoot: string
  extraEnv: Record<string, string>
}) => CandidateWorker

type ClientConstructor = new (
  worker: CandidateWorker,
  ref: { backend: 'mlx'; model: string; canonical: string }
) => AgentInferenceClient

async function importCandidate<T>(checkout: string, path: string): Promise<T>
{
  return (await import(pathToFileURL(resolve(checkout, path)).href)) as T
}

export async function verifyCandidateRevision(
  config: CustomMlxTopologyConfig
): Promise<void>
{
  const { stdout } = await execFileAsync('git', [
    '-C',
    config.checkout,
    'rev-parse',
    'HEAD',
  ])
  const actual = stdout.trim()
  if (actual !== config.expectedRevision)
  {
    throw new Error(
      `custom candidate is ${actual}, expected ${config.expectedRevision}`
    )
  }
  const { stdout: status } = await execFileAsync('git', [
    '-C',
    config.checkout,
    'status',
    '--porcelain',
  ])
  if (status.trim()) throw new Error('custom candidate checkout is dirty')
  await readFile(resolve(config.checkout, 'package.json'))
}

class CustomMlxRuntime implements BenchmarkRuntime
{
  readonly identity: TopologyIdentity
  private worker?: CandidateWorker
  private Client?: ClientConstructor

  constructor(private readonly config: CustomMlxTopologyConfig)
  {
    this.identity = topologyIdentity(config)
  }

  async start(initialPair: ModelPair): Promise<void>
  {
    if (this.worker) return
    await verifyCandidateRevision(this.config)
    const workerModule = await importCandidate<{
      WorkerSupervisor: WorkerConstructor
    }>(this.config.checkout, 'src/inference/worker-supervisor.ts')
    const clientModule = await importCandidate<{
      PythonInferenceClient: ClientConstructor
    }>(this.config.checkout, 'src/inference/python-client.ts')
    this.worker = new workerModule.WorkerSupervisor({
      repoRoot: this.config.checkout,
      extraEnv: {
        ...this.config.environment,
        CORAL_MLX_MODELS_DIR: dirname(initialPair.mlx.localPath),
      },
    })
    this.Client = clientModule.PythonInferenceClient
    const client = await this.client(initialPair)
    await client.showModel(`mlx:${basename(initialPair.mlx.localPath)}`)
  }

  async client(pair: ModelPair): Promise<AgentInferenceClient>
  {
    if (!this.worker || !this.Client)
    {
      throw new Error('custom MLX runtime is not started')
    }
    return new this.Client(this.worker, {
      backend: 'mlx',
      model: basename(pair.mlx.localPath),
      canonical: `mlx:${basename(pair.mlx.localPath)}`,
    })
  }

  model(pair: ModelPair): string
  {
    return `mlx:${basename(pair.mlx.localPath)}`
  }

  processRoots(): number[]
  {
    const pid = this.worker?.pid()
    return pid ? [pid] : []
  }

  async resetModel(pair: ModelPair): Promise<void>
  {
    await this.stop()
    await this.start(pair)
  }

  async crashAndRestart(pair: ModelPair): Promise<void>
  {
    const pid = this.worker?.pid()
    if (!pid) throw new Error('custom worker has no live pid')
    process.kill(-pid, 'SIGKILL')
    await this.stop()
    await this.start(pair)
  }

  async allocatorMemory(): Promise<undefined>
  {
    return undefined
  }

  async stop(): Promise<{ descendants: number[]; allExited: boolean }>
  {
    const roots = this.processRoots()
    const worker = this.worker
    this.worker = undefined
    this.Client = undefined
    await worker?.dispose()
    return {
      descendants: roots,
      allExited: await waitForPidsToExit(roots, 2_000),
    }
  }
}

export function createRuntimes(config: BenchmarkConfig): BenchmarkRuntime[]
{
  return config.topologies.map((topology) =>
  {
    switch (topology.kind)
    {
      case 'ollama':
        return new OllamaRuntime(topology, config)
      case 'stock-mlx':
        return new StockMlxRuntime(
          topology,
          config.modelPairs,
          config.software,
          config
        )
      case 'custom-mlx':
        return new CustomMlxRuntime(topology)
    }
  })
}
